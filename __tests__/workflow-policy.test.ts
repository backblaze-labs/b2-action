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

type WorkflowJob = {
  if?: unknown
}

type WorkflowConfig = {
  jobs?: Record<string, WorkflowJob>
  on?: Record<string, unknown> | string | string[]
}

describe('pull_request workflow policy', () => {
  it('does not skip protected read-only gates for Dependabot PRs', async () => {
    for (const workflowPath of protectedPullRequestWorkflows) {
      const workflow = await readWorkflow(workflowPath)

      expect(hasPullRequestTrigger(workflow), `${workflowPath} must run on pull_request`).toBe(true)

      for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
        const condition = jobCondition(job)
        const label = `${workflowPath} job ${jobName}`

        expect(condition, label).not.toMatch(/github\.actor\s*!=\s*['"]dependabot\[bot\]['"]/u)
        expect(condition.toLowerCase(), label).not.toContain('dependabot[bot]')
      }
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
