import { describe, expect, it } from 'vitest'

// @ts-expect-error scripts are dependency-free JavaScript, not typed modules.
const check = (await import('../scripts/changelog-check-lib.mjs')) as {
  isShipped: (file: string) => boolean
  isFragment: (file: string) => boolean
  missingEntry: (changedFiles: string[], addedFiles: string[]) => boolean
}

describe('changelog-check', () => {
  it('treats source, bundle, manifest, and dependency files as shipped', () => {
    for (const file of [
      'src/main.ts',
      'src/commands/copy.ts',
      'dist/index.js',
      'action.yml',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]) {
      expect(check.isShipped(file), file).toBe(true)
    }
  })

  it('does not treat tests, docs, or workflows as shipped', () => {
    for (const file of [
      '__tests__/main.test.ts',
      'README.md',
      'docs/README.md',
      '.github/workflows/ci.yml',
      'src-old/main.ts',
      'action.yml.bak',
    ]) {
      expect(check.isShipped(file), file).toBe(false)
    }
  })

  it('recognizes unreleased fragments and batched version files', () => {
    expect(check.isFragment('.changes/unreleased/Fixed-20261027-120000.yaml')).toBe(true)
    expect(check.isFragment('.changes/v1.3.0.md')).toBe(true)
    expect(check.isFragment('.changes/header.tpl.md')).toBe(false)
    expect(check.isFragment('.changes/unreleased/.gitkeep')).toBe(false)
    expect(check.isFragment('CHANGELOG.md')).toBe(false)
  })

  it('requires a fragment only when a shipped path changes', () => {
    const fragment = '.changes/unreleased/Fixed-20261027-120000.yaml'
    expect(check.missingEntry(['src/main.ts'], [])).toBe(true)
    expect(check.missingEntry(['src/main.ts', fragment], [fragment])).toBe(false)
    expect(check.missingEntry(['README.md', '__tests__/main.test.ts'], [])).toBe(false)
    expect(check.missingEntry([], [])).toBe(false)
  })

  it('does not accept an edited, rather than added, fragment', () => {
    expect(check.missingEntry(['src/main.ts', '.changes/v1.2.0.md'], [])).toBe(true)
  })
})
