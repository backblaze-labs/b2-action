import { mkdirSync, writeFileSync } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

// @ts-expect-error scripts are dependency-free JavaScript, not typed modules.
const runner = (await import('../scripts/run-batched-mutation-lib.mjs')) as {
  defaultPnpmCommand: (platform?: NodeJS.Platform) => string
  runBatchedMutation: (options?: {
    command?: string
    cwd?: string
    runCommand?: (command: string, args: string[], options: { cwd: string; stdio: string }) => void
    stderr?: (message: string) => void
    stdout?: (message: string) => void
  }) => number
  strykerArgs: (file: string) => string[]
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

  it('disables per-file Stryker break exits before enforcing the aggregate gate', async () => {
    const result = await runFixture({ statuses: ['Killed'] })

    expect(result.exitCode).toBe(0)
    expect(result.command).toBe('pnpm')
    expect(result.args).toEqual(runner.strykerArgs('src/example.ts'))
    expect(result.args).toContain('--thresholds.break')
    expect(result.args).toContain('0')
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
})

async function runFixture({
  beforeRun,
  childStatus,
  statuses = ['Killed'],
  threshold = 65,
  writeReport = true,
}: {
  beforeRun?: (cwd: string) => void
  childStatus?: number
  statuses?: string[]
  threshold?: number | null
  writeReport?: boolean
}) {
  const cwd = await mkdtemp(join(tmpdir(), 'b2-batched-mutation-'))
  tempDirs.push(cwd)
  writeConfig(cwd, threshold)
  beforeRun?.(cwd)

  let command = ''
  let args: string[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = runner.runBatchedMutation({
    command: 'pnpm',
    cwd,
    runCommand: (nextCommand, nextArgs, options) => {
      command = nextCommand
      args = nextArgs
      expect(options.cwd).toBe(cwd)
      if (writeReport) writeReportFile(cwd, statuses)
      if (childStatus !== undefined) {
        const error = new Error('simulated child failure') as Error & { status: number }
        error.status = childStatus
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

function writeConfig(cwd: string, threshold: number | null) {
  writeFileSync(
    join(cwd, 'stryker.conf.json'),
    JSON.stringify({
      mutate: ['src/example.ts'],
      thresholds: { break: threshold },
    }),
  )
}

function writeReportFile(cwd: string, statuses: string[]) {
  mkdirSync(join(cwd, 'reports/mutation'), { recursive: true })
  writeFileSync(
    join(cwd, 'reports/mutation/mutation.json'),
    JSON.stringify({
      files: {
        'src/example.ts': {
          mutants: statuses.map((status, index) => ({ id: String(index), status })),
        },
      },
    }),
  )
}

async function readAggregate(cwd: string) {
  return JSON.parse(await readFile(join(cwd, 'reports/mutation/aggregate.json'), 'utf8')) as unknown
}
