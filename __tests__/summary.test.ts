import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STEP_SUMMARY_MAX_ROWS, writeStepSummary } from '../src/summary.ts'

const ORIGINAL_GH_SUMMARY = process.env.GITHUB_STEP_SUMMARY

describe('writeStepSummary', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'b2-summary-'))
    path = join(dir, 'STEP_SUMMARY')
    process.env.GITHUB_STEP_SUMMARY = path
  })

  afterEach(async () => {
    if (ORIGINAL_GH_SUMMARY === undefined) {
      Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY')
    } else {
      process.env.GITHUB_STEP_SUMMARY = ORIGINAL_GH_SUMMARY
    }
    await rm(dir, { recursive: true, force: true })
  })

  it('writes a markdown table with totals and rows', async () => {
    await writeStepSummary({
      title: 'Test run',
      totals: { files: 2, bytes: 2048 },
      rows: [
        { fileName: 'a.bin', size: 1024, fileId: 'fid-a', sha1: 'a'.repeat(40), status: 'ok' },
        { fileName: 'b.bin', size: 1024, fileId: 'fid-b', sha1: null, status: 'ok' },
      ],
    })

    const out = await readFile(path, 'utf8')
    expect(out).toContain('## Test run')
    expect(out).toContain('**2** files')
    expect(out).toContain('**2.0 KB**')
    expect(out).toContain('total')
    expect(out).toContain('<code>a.bin</code>')
    expect(out).toContain('<code>fid-a</code>')
    expect(out).toContain('aaaaaaaaaaaa…')
    expect(out).toContain('<code>b.bin</code>')
    expect(out).toMatch(/\|------\|------/)
  })

  it('escapes pipes in table cells', async () => {
    await writeStepSummary({
      title: 'Pipe',
      rows: [{ fileName: 'evil|name.txt', fileId: 'fid|1', size: 1, status: 'ok' }],
    })
    const out = await readFile(path, 'utf8')
    expect(out).toContain('<code>evil&#124;name.txt</code>')
    expect(out).toContain('<code>fid&#124;1</code>')
  })

  it('escapes html in table code cells', async () => {
    await writeStepSummary({
      title: 'Html',
      rows: [{ fileName: '<unsafe>&file.txt', fileId: '<fid>&1', size: 1, status: 'ok' }],
    })
    const out = await readFile(path, 'utf8')
    expect(out).toContain('<code>&lt;unsafe&gt;&amp;file.txt</code>')
    expect(out).toContain('<code>&lt;fid&gt;&amp;1</code>')
  })

  it('caps rendered rows before appending the markdown summary', async () => {
    await writeStepSummary({
      title: 'Large run',
      rows: Array.from({ length: STEP_SUMMARY_MAX_ROWS + 5 }, (_, i) => ({
        fileName: `file-${i}.txt`,
      })),
    })

    const out = await readFile(path, 'utf8')
    expect(out).toContain(
      `Showing first ${STEP_SUMMARY_MAX_ROWS} of ${STEP_SUMMARY_MAX_ROWS + 5} rows.`,
    )
    expect(out).toContain('<code>file-99.txt</code>')
    expect(out).not.toContain('<code>file-100.txt</code>')
  })

  it('no-ops when GITHUB_STEP_SUMMARY is unset', async () => {
    Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY')
    // Should not throw.
    await writeStepSummary({ title: 'unset', rows: [{ fileName: 'x' }] })
  })

  it('handles empty rows gracefully (totals-only)', async () => {
    await writeStepSummary({
      title: 'No rows',
      totals: { files: 0, bytes: 0 },
      rows: [],
    })
    const out = await readFile(path, 'utf8')
    expect(out).toContain('## No rows')
    expect(out).toContain('**0** files')
    // No table header when there are no rows.
    expect(out).not.toMatch(/\| File \|/)
  })

  it('formats byte counts at each magnitude', async () => {
    await writeStepSummary({
      title: 'Magnitudes',
      totals: { files: 4, bytes: 2 * 1024 * 1024 * 1024 },
      rows: [
        { fileName: 'tiny', size: 500 },
        { fileName: 'kb', size: 2048 },
        { fileName: 'mb', size: 5 * 1024 * 1024 },
        { fileName: 'gb', size: 3 * 1024 * 1024 * 1024 },
      ],
    })
    const out = await readFile(path, 'utf8')
    expect(out).toContain('500 B')
    expect(out).toContain('2.0 KB')
    expect(out).toContain('5.0 MB')
    expect(out).toContain('3.00 GB')
  })
})
