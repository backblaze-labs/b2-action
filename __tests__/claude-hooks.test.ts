import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const guardDist = join(repo, '.claude/hooks/guard-dist.mjs')
const gateTemplate = join(repo, '.claude/skills/sdlc-hook-gate/assets/gate-template.sh')
const hasBashAndJq = process.platform !== 'win32' && spawnSync('jq', ['--version']).status === 0

function runGuard(input: string, projectDir = repo) {
  return spawnSync(process.execPath, [guardDist], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
  })
}

const edit = (filePath: string, projectDir = repo) =>
  runGuard(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: filePath } }), projectDir)

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

  it.each([
    ['through a symlink into dist/', 'link/x.js'],
    ['up from a symlink inside dist/', 'link/../index.js'],
  ])('denies an edit %s', (_label, filePath) => {
    const project = mkdtempSync(join(tmpdir(), 'b2-guard-dist-'))
    try {
      mkdirSync(join(project, 'dist', 'sub'), { recursive: true })
      symlinkSync(join(project, 'dist', 'sub'), join(project, 'link'), 'junction')
      const result = edit(filePath, project)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('"permissionDecision":"deny"')
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('fails closed on an unreadable tool call', () => {
    const result = runGuard('not json')
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('refusing the edit')
  })
})

describe.skipIf(!hasBashAndJq)('sdlc-hook-gate template, production release', () => {
  const call = JSON.stringify({
    tool_name: 'mcp__deploy-prod__release',
    tool_input: { version: 'abc1234', ticket: 'CHG-123' },
  })

  // Runs the gate with a fake `change-ticket` CLI that prints `output` and exits with `code`.
  function decide(output: string | undefined, code = 0): string {
    const bin = mkdtempSync(join(tmpdir(), 'b2-gate-'))
    try {
      if (output !== undefined) {
        const cli = join(bin, 'change-ticket')
        writeFileSync(cli, `#!/bin/bash\ncat <<'JSON'\n${output}\nJSON\nexit ${code}\n`)
        chmodSync(cli, 0o755)
      }
      const result = spawnSync('bash', [gateTemplate], {
        input: call,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
      })
      const parsed = JSON.parse(result.stdout) as {
        hookSpecificOutput: { permissionDecision: string }
      }
      return parsed.hookSpecificOutput.permissionDecision
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  }

  const approved = '{"state":"approved","version":"abc1234","approver":"alice"}'

  it('allows an approved ticket for the exact version', () => {
    expect(decide(approved)).toBe('allow')
  })

  it('denies when the lookup fails, even if it printed an approval', () => {
    expect(decide(approved, 1)).toBe('deny')
  })

  it('denies an approval with an empty or null approver', () => {
    expect(decide('{"state":"approved","version":"abc1234","approver":""}')).toBe('deny')
    expect(decide('{"state":"approved","version":"abc1234","approver":null}')).toBe('deny')
  })

  it('denies when the change system CLI is missing or prints garbage', () => {
    expect(decide(undefined)).toBe('deny')
    expect(decide('not json')).toBe('deny')
  })

  it('denies a pending ticket or one approved for another version', () => {
    expect(decide('{"state":"pending","version":"abc1234","approver":"alice"}')).toBe('deny')
    expect(decide('{"state":"approved","version":"ffff999","approver":"alice"}')).toBe('deny')
  })
})
