import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = join(repo, '.github/risk-tiers.json')
const classifier = join(repo, '.claude/skills/sdlc-risk-tiers/assets/classify.py')
const python = ['python3', 'python'].find(
  (cmd) => spawnSync(cmd, ['-c', 'import sys; assert sys.version_info >= (3, 8)']).status === 0,
)

type Tiers = { always_human_paths: string[] }
type Result = { tier: string; humans_required: number; force_human: boolean }

function classify(files: string[], extra: string[] = []): Result {
  const result = spawnSync(
    python as string,
    [classifier, '--config', config, '--files', ...files, ...extra],
    { encoding: 'utf8' },
  )
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as Result
}

describe.skipIf(!python)('risk tiers (docs/design-docs/review-process.md)', () => {
  it.each([
    ['README.md', 'low', false],
    ['docs/design-docs/index.md', 'low', false],
    ['__tests__/inputs.test.ts', 'low', false],
    ['.changes/unreleased/Fixed-20261124-120000.yaml', 'low', false],
    ['src/commands/upload.ts', 'medium', false],
    ['dist/index.js', 'medium', false],
    ['action.yml', 'medium', false],
    ['pnpm-lock.yaml', 'medium', false],
    ['.github/workflows/ci.yml', 'high', true],
    ['.github/actions/tracking-issue/action.yml', 'high', true],
    ['.claude/hooks/guard-dist.mjs', 'high', true],
    ['REVIEW.md', 'high', true],
    ['docs/design-docs/review-lessons.md', 'high', true],
    ['scripts/changelog-check-lib.mjs', 'high', true],
    ['scripts/claude-review-gate.mjs', 'high', true],
    ['src/inputs.ts', 'high', true],
    ['.github/risk-tiers.json', 'high', true],
  ])('puts %s in the %s tier', (file, tier, forced) => {
    const result = classify([file])
    expect(result.tier).toBe(tier)
    expect(result.force_human).toBe(forced)
  })

  it('lets one high-tier path lift the whole change', () => {
    expect(classify(['README.md', 'src/main.ts', 'REVIEW.md']).tier).toBe('high')
  })

  it('needs no human for a low-tier change by a trusted author', () => {
    expect(classify(['README.md'], ['--author', 'goanpeca']).humans_required).toBe(0)
  })

  it('adds an approver for an author outside the trusted list', () => {
    expect(classify(['README.md'], ['--author', 'someone-else']).humans_required).toBe(1)
    expect(classify(['src/main.ts'], ['--author', 'someone-else']).humans_required).toBe(2)
  })

  it('raises a large diff one tier', () => {
    expect(classify(['src/main.ts'], ['--lines', '801']).tier).toBe('high')
  })
})

describe('risk tiers config', () => {
  it('names every always-human path in CODEOWNERS', () => {
    const tiers = JSON.parse(readFileSync(config, 'utf8')) as Tiers
    const owned = readFileSync(join(repo, '.github/CODEOWNERS'), 'utf8')
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
    for (const path of tiers.always_human_paths) {
      expect(owned, path).toContain(`/${path.replace(/\*\*$/, '')}`)
    }
  })
})
