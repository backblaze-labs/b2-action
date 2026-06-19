import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseWorkflowPath = resolve(repoRoot, '.github/workflows/release.yml')

type WorkflowStep = {
  condition?: string
  name?: string
  raw: string
  run?: string
  uses?: string
}

type StepRunResult = {
  code: number | null
  ghCalls: string[]
  githubOutput: string
  output: string
}

type GhMode = 'expired' | 'success' | 'transient'

type StepRunOptions = {
  ghMode?: GhMode
  gitTags?: string[]
}

const shellIt = process.platform === 'win32' ? it.skip : it

describe('release workflow floating tag safety', () => {
  it('keeps stable release side effects ordered by workflow structure', async () => {
    const steps = parsePublishSteps(await readWorkflow())
    const deriveStep = namedStep(steps, 'Derive major-version floating tag')
    const latestStep = namedStep(steps, 'Verify stable tag is latest for major')
    const moveStep = namedStep(steps, 'Move major-version floating tag (e.g. v1)')
    const warningStep = namedStep(steps, 'Warn when stable floating tag is skipped')
    const releaseStep = namedStep(steps, 'Create / update GitHub Release')

    expect(steps.indexOf(deriveStep)).toBeLessThan(steps.indexOf(latestStep))
    expect(steps.indexOf(latestStep)).toBeLessThan(steps.indexOf(moveStep))
    expect(steps.indexOf(latestStep)).toBeLessThan(steps.indexOf(warningStep))
    expect(steps.indexOf(moveStep)).toBeLessThan(steps.indexOf(releaseStep))
    expect(steps.indexOf(warningStep)).toBeLessThan(steps.indexOf(releaseStep))
    expect(deriveStep.condition).toContain("steps.prerelease.outputs.is_prerelease == 'false'")
    expect(latestStep.condition).toContain("steps.prerelease.outputs.is_prerelease == 'false'")
    expect(moveStep.condition).toContain("steps.prerelease.outputs.is_prerelease == 'false'")
    expect(moveStep.condition).toContain('skip-floating-tag')
    expect(warningStep.condition).toContain("steps.prerelease.outputs.is_prerelease == 'false'")
    expect(warningStep.condition).toContain('workflow_dispatch')
    expect(warningStep.condition).toContain('skip-floating-tag')
    expect(releaseStep.uses).toContain('softprops/action-gh-release')
  })

  shellIt('classifies every hyphenated release tag as a pre-release', async () => {
    const prereleaseScript = stepRunScript(
      parsePublishSteps(await readWorkflow()),
      'Identify pre-release',
    )

    await expectPrereleaseOutput(prereleaseScript, 'v1.2.3-preview', true)
    await expectPrereleaseOutput(prereleaseScript, 'v1.2.3-alpha.1', true)
    await expectPrereleaseOutput(prereleaseScript, 'v1.2.3', false)
  })

  shellIt('executes the missing-token guard before any GitHub API call', async () => {
    const moveScript = moveFloatingTagScript(await readWorkflow())
    const result = await runStepScript(moveScript, {
      GH_TOKEN: '',
      MAJOR: 'v1',
      REF: 'v1.2.3',
    })

    expect(result.code).not.toBe(0)
    expect(result.ghCalls).toEqual([])
  })

  shellIt('executes the expired-token guard before tag refs are changed', async () => {
    const moveScript = moveFloatingTagScript(await readWorkflow())
    const result = await runStepScript(
      moveScript,
      {
        GH_TOKEN: 'expired-token',
        MAJOR: 'v1',
        REF: 'v1.2.3',
      },
      'expired',
    )

    expect(result.code).not.toBe(0)
    expect(result.ghCalls.length).toBeGreaterThan(0)
    expectNoRefMutation(result)
  })

  shellIt('classifies transient auth preflight failures without blaming credentials', async () => {
    const moveScript = moveFloatingTagScript(await readWorkflow())
    const result = await runStepScript(
      moveScript,
      {
        GH_TOKEN: 'available-token',
        MAJOR: 'v1',
        REF: 'v1.2.3',
      },
      'transient',
    )

    expect(result.code).not.toBe(0)
    expect(result.ghCalls.length).toBeGreaterThan(1)
    expectNoRefMutation(result)
  })

  shellIt('rejects older stable tags before release side effects', async () => {
    const latestScript = stepRunScript(
      parsePublishSteps(await readWorkflow()),
      'Verify stable tag is latest for major',
    )
    const result = await runStepScript(
      latestScript,
      {
        MAJOR: 'v1',
        REF: 'v1.2.3',
      },
      { gitTags: ['v1.2.3', 'v1.2.4'] },
    )

    expect(result.code).not.toBe(0)
    expect(result.ghCalls).toEqual([])
  })

  shellIt('accepts the newest stable tag for a major release', async () => {
    const latestScript = stepRunScript(
      parsePublishSteps(await readWorkflow()),
      'Verify stable tag is latest for major',
    )
    const result = await runStepScript(
      latestScript,
      {
        MAJOR: 'v1',
        REF: 'v1.10.0',
      },
      { gitTags: ['v1.2.10', 'v1.10.0', 'v2.0.0', 'v1.11.0-rc.1'] },
    )

    expect(result.code).toBe(0)
    expect(result.ghCalls).toEqual([])
  })

  shellIt('requires a recorded justification for the emergency skip path', async () => {
    const warningScript = stepRunScript(
      parsePublishSteps(await readWorkflow()),
      'Warn when stable floating tag is skipped',
    )
    const result = await runStepScript(warningScript, {
      GH_TOKEN: 'unused-token',
      JUSTIFICATION: '',
      MAJOR: 'v1',
      REF: 'v1.2.3',
    })

    expect(result.code).not.toBe(0)
    expect(result.output).toContain('skip-floating-tag-justification')
  })

  shellIt('escapes emergency skip justification before logging notice', async () => {
    const warningScript = stepRunScript(
      parsePublishSteps(await readWorkflow()),
      'Warn when stable floating tag is skipped',
    )
    const result = await runStepScript(warningScript, {
      JUSTIFICATION: 'manual % reason\n::error::spoof\rnext',
      MAJOR: 'v1',
      REF: 'v1.2.3\n::error::ref-spoof',
    })
    const escapedLineFeed = '%0A'
    const escapedCarriageReturn = '%0D'

    expect(result.code).toBe(0)
    expect(result.output).toContain(
      `::notice::skip-floating-tag justification: manual %25 reason%0A::error::spoof${escapedCarriageReturn}next`,
    )
    expect(result.output).not.toContain('\n::error::spoof')
    expect(result.output).toContain(
      `publishing v1.2.3${escapedLineFeed}::error::ref-spoof without moving v1`,
    )
    expect(result.output).not.toContain('\n::error::ref-spoof')
    expect(result.output).toContain('::warning::skip-floating-tag=true')
  })
})

async function readWorkflow(): Promise<string> {
  return await readFile(releaseWorkflowPath, 'utf8')
}

function moveFloatingTagScript(workflow: string): string {
  return stepRunScript(parsePublishSteps(workflow), 'Move major-version floating tag (e.g. v1)')
}

function namedStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name)
  expect(step, `Expected publish step named "${name}"`).toBeDefined()
  return step as WorkflowStep
}

function parsePublishSteps(workflow: string): WorkflowStep[] {
  const publishStart = workflow.indexOf('\n  publish:')
  expect(publishStart).toBeGreaterThan(-1)
  const stepsStart = workflow.indexOf('\n    steps:', publishStart)
  expect(stepsStart).toBeGreaterThan(-1)

  const lines = workflow.slice(stepsStart).split('\n').slice(1)
  const blocks: string[][] = []
  let current: string[] | undefined

  for (const line of lines) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(line)) {
      break
    }
    if (/^ {6}- /.test(line)) {
      if (current) {
        blocks.push(current)
      }
      current = [line]
      continue
    }
    if (current) {
      current.push(line)
    }
  }
  if (current) {
    blocks.push(current)
  }

  return blocks.map((block) => parseStepBlock(block.join('\n')))
}

function parseStepBlock(raw: string): WorkflowStep {
  const step: WorkflowStep = { raw }
  const firstLine = raw.match(/^ {6}- (name|uses):\s*(.+)$/m)
  if (firstLine) {
    const [, key, value] = firstLine
    if (key === 'name' && value !== undefined) {
      step.name = value
    }
    if (key === 'uses' && value !== undefined) {
      step.uses = value
    }
  }

  for (const match of raw.matchAll(/^ {8}(if|name|uses):\s*(.+)$/gm)) {
    const [, key, value] = match
    if (value === undefined) {
      continue
    }
    if (key === 'if') {
      step.condition = value
    } else if (key === 'name') {
      step.name = value
    } else if (key === 'uses') {
      step.uses = value
    }
  }

  const run = parseRunScript(raw)
  if (run !== undefined) {
    step.run = run
  }
  return step
}

function parseRunScript(raw: string): string | undefined {
  const lines = raw.split('\n')
  const runLine = lines.findIndex((line) => /^ {8}run: \|$/.test(line))
  if (runLine === -1) {
    return undefined
  }

  const scriptLines: string[] = []
  for (const line of lines.slice(runLine + 1)) {
    if (line.trim() === '') {
      scriptLines.push('')
      continue
    }
    if (!line.startsWith('          ')) {
      break
    }
    scriptLines.push(line.slice(10))
  }
  return scriptLines.join('\n')
}

function stepRunScript(steps: WorkflowStep[], name: string): string {
  const script = namedStep(steps, name).run
  expect(script, `Expected publish step "${name}" to have a run script`).toBeDefined()
  return script as string
}

async function runStepScript(
  script: string,
  env: Record<string, string>,
  optionsOrGhMode: GhMode | StepRunOptions = 'success',
): Promise<StepRunResult> {
  const options =
    typeof optionsOrGhMode === 'string' ? { ghMode: optionsOrGhMode } : optionsOrGhMode
  const tempDir = await mkdtemp(join(tmpdir(), 'b2-release-workflow-'))
  const scriptPath = join(tempDir, 'step.sh')
  const ghPath = join(tempDir, 'gh')
  const gitPath = join(tempDir, 'git')
  const ghLog = join(tempDir, 'gh.log')
  const githubOutputPath = join(tempDir, 'github-output')

  try {
    await writeFile(scriptPath, script)
    await chmod(scriptPath, 0o755)
    await writeFile(
      ghPath,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$*" >> "$FAKE_GH_LOG"',
        'case "$FAKE_GH_MODE" in',
        '  expired)',
        '    printf "%s\\n" "gh: Bad credentials (HTTP 401)" >&2',
        '    exit 1',
        '    ;;',
        '  transient)',
        '    printf "%s\\n" "gh: GitHub API unavailable (HTTP 503)" >&2',
        '    exit 1',
        '    ;;',
        '  *)',
        '    exit 0',
        '    ;;',
        ['e', 's', 'a', 'c'].join(''),
        '',
      ].join('\n'),
    )
    await chmod(ghPath, 0o755)
    if (options.gitTags !== undefined) {
      await writeFile(
        gitPath,
        [
          '#!/usr/bin/env bash',
          'if [ "$1" = "tag" ] && [ "$2" = "--list" ]; then',
          '  PATTERN=$3',
          '  while IFS= read -r TAG; do',
          '    case "$TAG" in',
          '      $PATTERN) printf "%s\\n" "$TAG" ;;',
          `${'    '}${['e', 's', 'a', 'c'].join('')}`,
          "  done <<'FAKE_GIT_TAGS'",
          ...options.gitTags,
          'FAKE_GIT_TAGS',
          '  exit 0',
          'fi',
          'printf "%s\\n" "unexpected fake git call: $*" >&2',
          'exit 1',
          '',
        ].join('\n'),
      )
      await chmod(gitPath, 0o755)
    }

    const result = await spawnBash(scriptPath, {
      ...env,
      FAKE_GH_LOG: ghLog,
      FAKE_GH_MODE: options.ghMode ?? 'success',
      GITHUB_API_RETRY_SECONDS: '0',
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_REPOSITORY: 'backblaze-labs/b2-action',
      PATH: `${tempDir}${delimiter}${process.env.PATH ?? ''}`,
    })

    return {
      ...result,
      ghCalls: await readGhCalls(ghLog),
      githubOutput: await readOptionalFile(githubOutputPath),
    }
  } finally {
    await rm(tempDir, { force: true, recursive: true })
  }
}

function spawnBash(
  scriptPath: string,
  env: Record<string, string>,
): Promise<Omit<StepRunResult, 'ghCalls' | 'githubOutput'>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('bash', ['-euo', 'pipefail', scriptPath], {
      env: {
        ...process.env,
        ...env,
      },
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolvePromise({
        code,
        output: `${stdout}${stderr}`,
      })
    })
  })
}

async function readGhCalls(logPath: string): Promise<string[]> {
  const log = await readOptionalFile(logPath)
  return log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function expectNoRefMutation(result: StepRunResult): void {
  expect(
    result.ghCalls.some(
      (call) => call.includes('--method PATCH') || call.includes('--method POST'),
    ),
  ).toBe(false)
}

async function expectPrereleaseOutput(
  script: string,
  ref: string,
  expected: boolean,
): Promise<void> {
  const result = await runStepScript(script, { REF: ref })

  expect(result.code).toBe(0)
  expect(result.githubOutput).toContain(`is_prerelease=${expected}`)
}
