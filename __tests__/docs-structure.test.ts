import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Structural gate for the harness documentation. The blueprint in AGENTS.md /
// docs/ is only as good as its enforcement: these tests promote the "keep it a
// map, keep it cross-linked" rules into code so the system of record can't
// silently rot. See docs/design-docs/core-beliefs.md.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// AGENTS.md is a table of contents, not a manual (blueprint: a ~100-line map).
// Cap with headroom so ordinary edits don't trip it, but a slow slide into an
// encyclopedia does.
const MAX_AGENTS_LINES = 120

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'api-docs',
  'coverage',
  'reports',
  '.stryker-tmp',
])

describe('harness documentation structure', () => {
  it('keeps AGENTS.md a short map, not an encyclopedia', async () => {
    const agents = await readFile(join(repoRoot, 'AGENTS.md'), 'utf8')
    const lines = agents.split('\n').length
    expect(lines).toBeLessThanOrEqual(MAX_AGENTS_LINES)
  })

  it('points every tool-specific harness file at the canonical AGENTS.md', async () => {
    for (const file of ['CLAUDE.md', 'GEMINI.md']) {
      const body = await readFile(join(repoRoot, file), 'utf8')
      const targets = markdownLinkTargets(body, dirname(join(repoRoot, file)))
      expect(targets).toContain(resolve(repoRoot, 'AGENTS.md'))
    }
  })

  it('has no orphan docs: every docs/**/*.md is linked from another doc', async () => {
    const allMarkdown = await collectMarkdown(repoRoot)
    const linked = new Set<string>()
    for (const file of allMarkdown) {
      const body = await readFile(file, 'utf8')
      for (const target of markdownLinkTargets(body, dirname(file))) {
        linked.add(target)
      }
    }

    const docsFiles = allMarkdown.filter((file) => file.startsWith(join(repoRoot, 'docs')))
    const orphans = docsFiles
      .filter((file) => !linked.has(file))
      .map((file) => relative(repoRoot, file))
    expect(orphans).toEqual([])
  })

  it('lists every design doc in the design-docs index', async () => {
    const indexDir = join(repoRoot, 'docs/design-docs')
    const index = await readFile(join(indexDir, 'index.md'), 'utf8')
    const linked = new Set(markdownLinkTargets(index, indexDir))

    const designDocs = (await readdir(indexDir))
      .filter((name) => name.endsWith('.md') && name !== 'index.md')
      .map((name) => join(indexDir, name))

    const missing = designDocs
      .filter((file) => !linked.has(file))
      .map((file) => relative(repoRoot, file))
    expect(missing).toEqual([])
  })

  it('keeps tech-debt tracker ids unique', async () => {
    const tracker = await readFile(join(repoRoot, 'docs/exec-plans/tech-debt-tracker.md'), 'utf8')
    // One id per table row (ids also recur in the details section by design).
    const ids = [...tracker.matchAll(/^\| (TD-\d{4}) \|/gm)].map((match) => match[1])
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/** Resolve every relative markdown link in `body` to an absolute path (fragments stripped). */
function markdownLinkTargets(body: string, fromDir: string): string[] {
  const targets: string[] = []
  for (const match of body.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = match[1]?.split(/\s+/)[0]
    if (raw === undefined || raw === '') continue
    if (/^[a-z]+:/i.test(raw) || raw.startsWith('#')) continue
    const withoutFragment = raw.split('#')[0]
    if (withoutFragment === undefined || withoutFragment === '') continue
    targets.push(resolve(fromDir, withoutFragment))
  }
  return targets
}

/** Recursively collect tracked-style markdown files, skipping build output. */
async function collectMarkdown(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      files.push(...(await collectMarkdown(join(dir, entry.name))))
    } else if (entry.name.endsWith('.md')) {
      files.push(join(dir, entry.name))
    }
  }
  return files
}
