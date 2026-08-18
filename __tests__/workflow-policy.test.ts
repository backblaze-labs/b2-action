import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const protectedPullRequestWorkflows = [
  '.github/workflows/ci.yml',
  '.github/workflows/docs-lint.yml',
  '.github/workflows/security.yml',
  '.github/workflows/full-lockfile-audit.yml',
]
const localActionSecretedExamples = ['.github/workflows/example-ml-cache-sync.yml']

type WorkflowJob = {
  if?: unknown
  steps?: WorkflowStep[]
}

type WorkflowStep = {
  uses?: unknown
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

type WorkflowConfig = {
  jobs?: Record<string, WorkflowJob>
  on?: Record<string, unknown> | string | string[]
}

describe('pull_request workflow policy', () => {
  it('skips every pull_request job for Dependabot PRs', async () => {
    for (const workflowPath of protectedPullRequestWorkflows) {
      const workflow = await readWorkflow(workflowPath)

      expect(hasPullRequestTrigger(workflow), `${workflowPath} must run on pull_request`).toBe(true)

      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const condition = jobCondition(job)
        const label = `${workflowPath} job ${jobName}`

        // Policy: Dependabot PRs run no CI. Every job in a pull_request-triggered
        // workflow must be gated so it is skipped for the dependabot[bot] actor.
        expect(condition, label).toMatch(/github\.actor\s*!=\s*['"]dependabot\[bot\]['"]/u)
      }
    }
  })

  it('does not expose B2 secrets to pull_request runs of local example action code', async () => {
    for (const workflowPath of localActionSecretedExamples) {
      const workflow = await readWorkflow(workflowPath)
      const secretedLocalSteps = localActionStepsUsingB2Secrets(workflow)

      expect(
        secretedLocalSteps.length,
        `${workflowPath} should contain at least one secreted local-action step for this policy guard`,
      ).toBeGreaterThan(0)
      expect(
        hasPullRequestTrigger(workflow),
        `${workflowPath} must not run PR-controlled uses: ./ code with B2 secrets`,
      ).toBe(false)
    }
  })
})

async function readWorkflow(workflowPath: string): Promise<WorkflowConfig> {
  return parse(await readFile(resolve(repoRoot, workflowPath), 'utf8')) as WorkflowConfig
}

function hasPullRequestTrigger(workflow: WorkflowConfig): boolean {
  if (typeof workflow.on === 'string') return workflow.on === 'pull_request'
  if (Array.isArray(workflow.on)) return workflow.on.includes('pull_request')
  return Object.hasOwn(workflow.on ?? {}, 'pull_request')
}

function jobCondition(job: WorkflowJob): string {
  return typeof job.if === 'string' ? job.if : ''
}

function localActionStepsUsingB2Secrets(workflow: WorkflowConfig): WorkflowStep[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? []).filter(
      (step) => step.uses === './' && JSON.stringify([step.with, step.env]).includes('secrets.B2_'),
    ),
  )
}
