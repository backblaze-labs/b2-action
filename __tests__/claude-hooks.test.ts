import { spawnSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const guardDist = join(repo, '.claude/hooks/guard-dist.mjs')

function runGuard(input: string) {
  return spawnSync(process.execPath, [guardDist], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
  })
}

const edit = (filePath: string) =>
  runGuard(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }))

describe('guard-dist hook', () => {
  it.each([
    ['relative', 'dist/index.js'],
    ['dot-relative', './dist/index.js'],
    ['absolute', `${repo}${sep}dist${sep}index.js`],
    ['absolute with a dot segment', `${repo}${sep}.${sep}dist${sep}index.js`],
    ['parent traversal', 'src/../dist/index.js'],
    ['a not-yet-existing file', 'dist/new-chunk.js'],
  ])('denies an edit to the bundle via a %s path', (_label, filePath) => {
    const result = edit(filePath)
    expect(result.status).toBe(0)
    const decision = JSON.parse(result.stdout) as {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string }
    }
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny')
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('pnpm build')
  })

  it.each([
    ['source', 'src/main.ts'],
    ['dist-like sibling', 'dist-notes.md'],
    ['nested dist directory', 'src/dist/helper.ts'],
  ])('allows a %s edit', (_label, filePath) => {
    const result = edit(filePath)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it('fails closed on an unreadable tool call', () => {
    const result = runGuard('not json')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('refusing the edit')
  })
})
