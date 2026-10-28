import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// @ts-expect-error scripts are dependency-free JavaScript, not typed modules.
const check = (await import('../scripts/changelog-check-lib.mjs')) as {
  isShipped: (file: string) => boolean
  isUnreleasedFragment: (file: string) => boolean
  isVersionFile: (file: string) => boolean
  isValidFragment: (parsed: unknown) => boolean
  isValidReleaseNotes: (file: string, text: string, packageVersion: string) => boolean
  missingEntry: (changedFiles: string[], validEntryCount: number) => boolean
}

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

describe('changelog-check helpers', () => {
  it('treats source, bundle, manifest, dependency, and workflow files as shipped', () => {
    for (const file of [
      'src/main.ts',
      'dist/index.js',
      'action.yml',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.github/workflows/release.yml',
      '.github/actions/tracking-issue/action.yml',
    ]) {
      expect(check.isShipped(file), file).toBe(true)
    }
  })

  it('does not treat tests, docs, or other repo config as shipped', () => {
    for (const file of [
      '__tests__/main.test.ts',
      'README.md',
      'docs/README.md',
      '.github/CODEOWNERS',
      'src-old/main.ts',
      'action.yml.bak',
    ]) {
      expect(check.isShipped(file), file).toBe(false)
    }
  })

  it('tells unreleased fragments apart from batched version files', () => {
    expect(check.isUnreleasedFragment('.changes/unreleased/Fixed-20261027-120000.yaml')).toBe(true)
    expect(check.isUnreleasedFragment('.changes/v1.3.0.md')).toBe(false)
    expect(check.isVersionFile('.changes/v1.3.0.md')).toBe(true)
    expect(check.isVersionFile('.changes/header.tpl.md')).toBe(false)
    expect(check.isUnreleasedFragment('.changes/unreleased/.gitkeep')).toBe(false)
  })

  it('accepts a fragment only with a non-empty kind and body', () => {
    expect(check.isValidFragment({ kind: 'Fixed', body: 'A fix.' })).toBe(true)
    expect(check.isValidFragment({ kind: 'Fixed', body: '   ' })).toBe(false)
    expect(check.isValidFragment({ kind: '', body: 'A fix.' })).toBe(false)
    expect(check.isValidFragment({ body: 'A fix.' })).toBe(false)
    expect(check.isValidFragment(null)).toBe(false)
  })

  it('accepts release notes only for the package version, with an entry', () => {
    const notes = '## [1.3.0] - 2026-10-27\n\n### Fixed\n\n- A fix.\n'
    expect(check.isValidReleaseNotes('.changes/v1.3.0.md', notes, '1.3.0')).toBe(true)
    expect(check.isValidReleaseNotes('.changes/v1.3.0.md', '', '1.3.0')).toBe(false)
    expect(check.isValidReleaseNotes('.changes/v1.3.0.md', '## [1.3.0]\n', '1.3.0')).toBe(false)
    expect(check.isValidReleaseNotes('.changes/v9.9.9.md', notes, '1.3.0')).toBe(false)
  })

  it('requires an entry only when a shipped path changes', () => {
    expect(check.missingEntry(['src/main.ts'], 0)).toBe(true)
    expect(check.missingEntry(['src/main.ts'], 1)).toBe(false)
    expect(check.missingEntry(['README.md'], 0)).toBe(false)
  })
})

const hasGit = spawnSync('git', ['--version']).status === 0

describe.skipIf(!hasGit)('changelog-check script', () => {
  let root: string

  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.email=t@example.com',
        '-c',
        'user.name=t',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: root, stdio: 'pipe' },
    )
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  const commit = () => {
    git('add', '-A')
    git('commit', '-qm', 'change')
  }
  const runCheck = () =>
    spawnSync(process.execPath, [join(repo, 'scripts/changelog-check.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, CHANGELOG_CHECK_ROOT: root, BASE_REF: 'base' },
    })
  const fragment = 'kind: Fixed\nbody: A user-visible fix.\ntime: 2026-10-27T00:00:00Z\n'
  const packageJson = (version: string) =>
    `${JSON.stringify({ name: 'b2', version, private: true }, null, 2)}\n`

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'b2-changelog-check-'))
    git('init', '-q', '-b', 'main')
    cpSync(join(repo, '.changie.yaml'), join(root, '.changie.yaml'))
    cpSync(join(repo, '.changes/header.tpl.md'), join(root, '.changes/header.tpl.md'))
    cpSync(join(repo, '.changes/v1.2.0.md'), join(root, '.changes/v1.2.0.md'))
    write('src/a.ts', 'export const a = 1\n')
    write('.github/workflows/w.yml', 'on: push\n')
    write('package.json', packageJson('1.2.0'))
    commit()
    git('branch', 'base')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('fails a source change without an entry', () => {
    write('src/a.ts', 'export const a = 2\n')
    commit()
    expect(runCheck().status).toBe(1)
  })

  it('passes a source change with a valid fragment', () => {
    write('src/a.ts', 'export const a = 2\n')
    write('.changes/unreleased/Fixed-20261027-120000.yaml', fragment)
    commit()
    const result = runCheck()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })

  it('fails a source change with an empty version file and no fragment', () => {
    write('src/a.ts', 'export const a = 2\n')
    write('.changes/v1.3.0.md', '')
    commit()
    const result = runCheck()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('adds no changelog entry')
  })

  it('fails empty release notes for the version being released', () => {
    write('package.json', packageJson('1.3.0'))
    write('.changes/v1.3.0.md', '## [1.3.0] - 2026-10-27\n')
    commit()
    const result = runCheck()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('not valid release notes')
  })

  it('ignores historical version files, which neither satisfy nor fail the check', () => {
    write('src/a.ts', 'export const a = 2\n')
    write('.changes/v1.0.0.md', '## [1.0.0] - 2026-05-28\n\n### Added\n\n- First release.\n')
    commit()
    expect(runCheck().status).toBe(1)
    write('.changes/unreleased/Fixed-20261027-120000.yaml', fragment)
    commit()
    expect(runCheck().status).toBe(0)
  })

  it('fails a fragment with an empty body', () => {
    write('src/a.ts', 'export const a = 2\n')
    write('.changes/unreleased/Fixed-20261027-120000.yaml', 'kind: Fixed\nbody: ""\n')
    commit()
    expect(runCheck().status).toBe(1)
  })

  it('fails a workflow-only change without an entry', () => {
    write('.github/workflows/w.yml', 'on: pull_request\n')
    commit()
    expect(runCheck().status).toBe(1)
  })

  it('passes a docs-only change without an entry', () => {
    write('README.md', '# docs\n')
    commit()
    expect(runCheck().status).toBe(0)
  })

  it('passes a release PR whose notes match the package version', () => {
    write('package.json', packageJson('1.3.0'))
    write('.changes/v1.3.0.md', '## [1.3.0] - 2026-10-27\n\n### Fixed\n\n- A user-visible fix.\n')
    commit()
    expect(runCheck().status).toBe(0)
  })
})
