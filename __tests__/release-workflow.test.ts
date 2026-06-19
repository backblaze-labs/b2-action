import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const releaseWorkflowPath = resolve(repoRoot, '.github/workflows/release.yml')

describe('release workflow floating tag safety', () => {
  it('fails missing or invalid float credentials before publishing a stable release', async () => {
    const workflow = await readWorkflow()
    const moveStep = stepBlock(workflow, 'Move major-version floating tag (e.g. v1)')
    const publishIndex = stepIndex(workflow, 'Create / update GitHub Release')
    const missingTokenGuard = moveStep.search(/if \[ -z "\$\{GH_TOKEN:-\}" \]; then/)
    const authProbe = moveStep.indexOf('gh api "repos/$GITHUB_REPOSITORY"')
    const tagRead = moveStep.indexOf('git/matching-refs/tags/$MAJOR')
    const tagPatch = moveStep.indexOf('gh api --method PATCH')

    expect(stepIndex(workflow, 'Move major-version floating tag (e.g. v1)')).toBeLessThan(
      publishIndex,
    )
    expect(missingTokenGuard).toBeGreaterThan(-1)
    expect(authProbe).toBeGreaterThan(-1)
    expect(tagRead).toBeGreaterThan(-1)
    expect(missingTokenGuard).toBeLessThan(tagPatch)
    expect(authProbe).toBeLessThan(tagPatch)
    expect(moveStep).toContain('The GitHub Release has not been created yet')
  })

  it('requires an explicit workflow_dispatch override before publishing without a float', async () => {
    const workflow = await readWorkflow()
    const moveStep = stepBlock(workflow, 'Move major-version floating tag (e.g. v1)')
    const warningStep = stepBlock(workflow, 'Warn when stable floating tag is skipped')

    expect(workflow).toContain('skip-floating-tag:')
    expect(moveStep).toContain("inputs['skip-floating-tag'] == false")
    expect(warningStep).toContain('skip-floating-tag=true')
    expect(stepIndex(workflow, 'Warn when stable floating tag is skipped')).toBeLessThan(
      stepIndex(workflow, 'Create / update GitHub Release'),
    )
  })
})

async function readWorkflow(): Promise<string> {
  return await readFile(releaseWorkflowPath, 'utf8')
}

function stepIndex(workflow: string, name: string): number {
  const index = workflow.indexOf(`- name: ${name}`)
  expect(index).toBeGreaterThan(-1)
  return index
}

function stepBlock(workflow: string, name: string): string {
  const start = stepIndex(workflow, name)
  const next = workflow.indexOf('\n      - name:', start + 1)
  return workflow.slice(start, next === -1 ? undefined : next)
}
