import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docsLintWorkflowPath = resolve(repoRoot, '.github/workflows/docs-lint.yml')
const packageJsonPath = resolve(repoRoot, 'package.json')

type WorkflowStep = {
  run?: string
  uses?: string
}

type WorkflowJob = {
  'timeout-minutes'?: number
  steps?: WorkflowStep[]
}

type WorkflowConfig = {
  jobs?: Record<string, WorkflowJob>
  on?: Record<string, unknown>
}

type PackageJson = {
  scripts?: Record<string, string>
}

describe('docs-lint workflow policy', () => {
  it('keeps pull_request docs tooling off lifecycle scripts and package scripts', async () => {
    const [workflow, scripts] = await Promise.all([readWorkflow(), readPackageScripts()])

    expect(workflow.on?.pull_request).toBeDefined()

    const markdownlint = workflowJob(workflow, 'markdownlint')
    const linkCheck = workflowJob(workflow, 'link-check')
    const spellcheck = workflowJob(workflow, 'spellcheck')

    expect(markdownlint['timeout-minutes']).toBe(10)
    expect(linkCheck['timeout-minutes']).toBe(10)
    expect(spellcheck['timeout-minutes']).toBe(10)

    expect(runLines(markdownlint)).toContain(`pnpm exec ${script(scripts, 'docs:lint')}`)
    expect(runLines(linkCheck)).toContain(script(scripts, 'docs:links'))
    expect(runLines(spellcheck)).toContain(`pnpm exec ${script(scripts, 'spellcheck')}`)

    assertSafePnpmInstall(markdownlint)
    assertSafePnpmInstall(spellcheck)
    expectNoPackageScripts(
      [markdownlint, linkCheck, spellcheck],
      ['docs:lint', 'docs:links', 'spellcheck'],
    )
  })
})

async function readWorkflow(): Promise<WorkflowConfig> {
  return parse(await readFile(docsLintWorkflowPath, 'utf8')) as WorkflowConfig
}

async function readPackageScripts(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8')) as PackageJson
  if (packageJson.scripts === undefined) {
    throw new Error('package.json must define scripts')
  }
  return packageJson.scripts
}

function workflowJob(workflow: WorkflowConfig, name: string): WorkflowJob {
  const job = workflow.jobs?.[name]
  if (job === undefined) {
    throw new Error(`docs-lint workflow must define ${name} job`)
  }
  return job
}

function script(scripts: Record<string, string>, name: string): string {
  const value = scripts[name]
  if (value === undefined) {
    throw new Error(`package.json must define ${name} script`)
  }
  return value
}

function runBlocks(job: WorkflowJob): string[] {
  return (job.steps ?? []).flatMap((step) => (step.run === undefined ? [] : [step.run]))
}

function runLines(job: WorkflowJob): string[] {
  return runBlocks(job)
    .flatMap((run) => run.split(/\r?\n/))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function assertSafePnpmInstall(job: WorkflowJob): void {
  const lines = runLines(job)
  const installs = lines.filter((line) => /\bpnpm install\s+--/.test(line))

  expect(installs.length).toBeGreaterThan(0)
  for (const install of installs) {
    expect(install).toContain('--frozen-lockfile')
    expect(install).toContain('--ignore-scripts')
  }
  expect(runBlocks(job).some((run) => run.includes('for attempt in 1 2 3'))).toBe(true)
  expect(runBlocks(job).some((run) => run.includes('pnpm install failed after 3 attempts'))).toBe(
    true,
  )
}

function expectNoPackageScripts(jobs: WorkflowJob[], scriptNames: string[]): void {
  const scriptPattern = new RegExp(
    `^pnpm\\s+(run\\s+)?(${scriptNames.map(escapeRegExp).join('|')})(\\s|$)`,
  )
  const scriptRuns = jobs.flatMap((job) => runLines(job)).filter((line) => scriptPattern.test(line))

  expect(scriptRuns).toEqual([])
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
