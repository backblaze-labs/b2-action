import { mkdirSync, writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const scriptPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts/run-batched-mutation.mjs',
)

// @ts-expect-error scripts are dependency-free JavaScript, not typed modules.
const runner = (await import('../scripts/run-batched-mutation-lib.mjs')) as {
  BY_FILE_DIR: string
  defaultPnpmCommand: (platform?: NodeJS.Platform) => string
  isEntrypoint: (metaUrl: string, argv1: string | undefined) => boolean
  PER_FILE_CONFIG: string
  runBatchedMutation: (options?: {
    command?: string
    cwd?: string
    runCommand?: (command: string, args: string[], options: { cwd: string; stdio: string }) => void
    stderr?: (message: string) => void
    stdout?: (message: string) => void
  }) => number
  strykerArgs: () => string[]
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

describe('batched mutation runner', () => {
  it('uses the platform-specific pnpm command by default', () => {
    expect(runner.defaultPnpmCommand('darwin')).toBe('pnpm')
    expect(runner.defaultPnpmCommand('linux')).toBe('pnpm')
    expect(runner.defaultPnpmCommand('win32')).toBe('pnpm.cmd')
  })

  it('normalizes entrypoint paths before comparing them', () => {
    expect(
      runner.isEntrypoint(pathToFileURL(scriptPath).href, relative(process.cwd(), scriptPath)),
    ).toBe(true)
    expect(runner.isEntrypoint(pathToFileURL(scriptPath).href, undefined)).toBe(false)
  })

  it('invokes Stryker per file without the unsupported --thresholds.break flag', async () => {
    const result = await runFixture({ statuses: ['Killed'] })

    expect(result.exitCode).toBe(0)
    expect(result.command).toBe('pnpm')
    expect(result.args).toEqual(runner.strykerArgs())
    // Stryker 9.x removed dot-notation CLI options, so passing --thresholds.break
    // makes every per-file run fail with "unknown option". The generated
    // per-file config disables the break threshold for the subprocess instead.
    expect(result.args).not.toContain('--thresholds.break')
    await expect(readPerFileConfig(result.cwd)).resolves.toMatchObject({
      mutate: ['src/example.ts'],
      thresholds: { break: null },
    })
  })

  it('fails all-error reports instead of treating an empty valid denominator as 100%', async () => {
    const result = await runFixture({ statuses: ['RuntimeError', 'CompileError'] })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('errored mutant')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 0,
      totals: { errors: 2 },
    })
  })

  it('fails mixed errored reports even when some mutants are killed', async () => {
    const result = await runFixture({ statuses: ['Killed', 'RuntimeError'] })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('errored mutant')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 50,
      totals: { errors: 1, killed: 1 },
    })
  })

  it('fails reports that contain unknown mutant statuses', async () => {
    const result = await runFixture({ statuses: ['Killed', 'Transmogrified'] })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('unknown mutant status')
    expect(result.stderr).toContain('Transmogrified: 1')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 50,
      totals: { killed: 1, unknown: 1 },
    })
  })

  it('fails when Stryker exits nonzero even if a JSON report exists', async () => {
    const result = await runFixture({ childStatus: 2, statuses: ['Killed'] })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('subprocesses failed')
    expect(result.stderr).toContain('exit status 2')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 100,
      totals: { killed: 1 },
    })
  })

  it('passes when a per-file threshold exit still meets the aggregate gate', async () => {
    const result = await runFixture({
      childStatuses: { 'src/example.ts': 1 },
      files: ['src/example.ts', 'src/covered.ts'],
      statusesByFile: {
        'src/covered.ts': ['Killed', 'Killed'],
        'src/example.ts': ['Survived'],
      },
      threshold: 65,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).not.toContain('subprocesses failed')

    const aggregate = (await readAggregate(result.cwd)) as {
      score: number
      threshold: number
      totals: { killed: number; survived: number }
    }
    expect(aggregate.score).toBeCloseTo(66.67, 2)
    expect(aggregate).toMatchObject({
      threshold: 65,
      totals: { killed: 2, survived: 1 },
    })
  })

  it('fails when Stryker does not produce a report', async () => {
    const result = await runFixture({ writeReport: false })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('produced no report')
  })

  it('does not enforce the aggregate gate when thresholds.break is null', async () => {
    const result = await runFixture({ statuses: ['Survived'], threshold: null })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('no break threshold configured')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 0,
      threshold: null,
      totals: { survived: 1 },
    })
  })

  it('fails when the aggregate score is below thresholds.break', async () => {
    const result = await runFixture({ statuses: ['Survived'], threshold: 65 })

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('below break threshold 65')
    await expect(readAggregate(result.cwd)).resolves.toMatchObject({
      score: 0,
      threshold: 65,
      totals: { survived: 1 },
    })
  })

  it('clears stale per-file reports before writing the current run artifacts', async () => {
    const result = await runFixture({
      beforeRun: (cwd) => writeStaleByFileReport(cwd),
      statuses: ['Killed'],
    })

    expect(result.exitCode).toBe(0)
    await expect(
      access(join(result.cwd, 'reports/mutation/by-file/src__removed.ts.json')),
    ).rejects.toThrow(/ENOENT/u)
    await expect(
      access(join(result.cwd, 'reports/mutation/by-file/src__example.ts.json')),
    ).resolves.toBeUndefined()
  })

  it('flattens POSIX and Windows separators in per-file report names', async () => {
    const result = await runFixture({
      files: ['src/example.ts', 'src\\windows\\example.ts'],
      statuses: ['Killed'],
    })

    expect(result.exitCode).toBe(0)
    await expect(
      access(join(result.cwd, runner.BY_FILE_DIR, 'src__example.ts.json')),
    ).resolves.toBeUndefined()
    await expect(
      access(join(result.cwd, runner.BY_FILE_DIR, 'src__windows__example.ts.json')),
    ).resolves.toBeUndefined()
  })
})

async function runFixture({
  beforeRun,
  childStatus,
  childStatuses = {},
  files = ['src/example.ts'],
  statuses = ['Killed'],
  statusesByFile = {},
  threshold = 65,
  writeReport = true,
}: {
  beforeRun?: (cwd: string) => void
  childStatus?: number
  childStatuses?: Record<string, number>
  files?: string[]
  statuses?: string[]
  statusesByFile?: Record<string, string[]>
  threshold?: number | null
  writeReport?: boolean
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'b2-batched-mutation-'))
  tempDirs.push(cwd)
  writeConfig(cwd, threshold, files)
  beforeRun?.(cwd)

  let command = ''
  let args: string[] = []
  let runIndex = 0
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = runner.runBatchedMutation({
    command: 'pnpm',
    cwd,
    runCommand: (nextCommand, nextArgs, options) => {
      command = nextCommand
      args = nextArgs
      const file = files[runIndex]
      runIndex += 1
      if (file === undefined) throw new Error('Unexpected extra Stryker invocation')
      expect(options.cwd).toBe(cwd)
      if (writeReport) writeReportFile(cwd, file, statusesByFile[file] ?? statuses)
      const nextChildStatus = childStatuses[file] ?? childStatus
      if (nextChildStatus !== undefined) {
        const error = new Error('simulated child failure') as Error & { status: number }
        error.status = nextChildStatus
        throw error
      }
    },
    stderr: (message) => stderr.push(message),
    stdout: (message) => stdout.push(message),
  })

  return {
    args,
    command,
    cwd,
    exitCode,
    stderr: stderr.join('\n'),
    stdout: stdout.join('\n'),
  }
}

function writeStaleByFileReport(cwd: string) {
  mkdirSync(join(cwd, 'reports/mutation/by-file'), { recursive: true })
  writeFileSync(join(cwd, 'reports/mutation/by-file/src__removed.ts.json'), '{}')
}

function writeConfig(cwd: string, threshold: number | null, files: string[]) {
  writeFileSync(
    join(cwd, 'stryker.conf.json'),
    JSON.stringify({
      mutate: files,
      thresholds: { break: threshold },
    }),
  )
}

function writeReportFile(cwd: string, file: string, statuses: string[]) {
  mkdirSync(join(cwd, 'reports/mutation'), { recursive: true })
  writeFileSync(
    join(cwd, 'reports/mutation/mutation.json'),
    JSON.stringify({
      files: {
        [file]: {
          mutants: statuses.map((status, index) => ({ id: String(index), status })),
        },
      },
    }),
  )
}

async function readAggregate(cwd: string) {
  return JSON.parse(await readFile(join(cwd, 'reports/mutation/aggregate.json'), 'utf8')) as unknown
}

async function readPerFileConfig(cwd: string) {
  return JSON.parse(await readFile(join(cwd, runner.PER_FILE_CONFIG), 'utf8')) as unknown
}
