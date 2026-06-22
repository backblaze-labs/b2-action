import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  buildSummaryJsonPayload,
  SUMMARY_JSON_MAX_ENTRIES,
  SUMMARY_JSON_MAX_UTF16_BYTES,
} from '../src/outputs.ts'

describe('summary-json output guard', () => {
  it('passes through small payloads unchanged', () => {
    const items = [{ fileName: 'a.txt' }, { fileName: 'b.txt' }]

    const payload = buildSummaryJsonPayload(items)

    expect(payload).toEqual({
      json: JSON.stringify(items),
      totalCount: 2,
      emittedCount: 2,
      truncated: false,
    })
  })

  it('caps payloads to the supported entry count', () => {
    const items = Array.from({ length: SUMMARY_JSON_MAX_ENTRIES + 5 }, (_, i) => ({
      fileName: `file-${i}.txt`,
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(payload.totalCount).toBe(SUMMARY_JSON_MAX_ENTRIES + 5)
    expect(payload.emittedCount).toBe(SUMMARY_JSON_MAX_ENTRIES)
    expect(JSON.parse(payload.previewJson)).toHaveLength(SUMMARY_JSON_MAX_ENTRIES)
  })

  it('trims payloads that exceed the supported UTF-16 size', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      fileName: `large-${i}.txt`,
      metadata: 'x'.repeat(SUMMARY_JSON_MAX_UTF16_BYTES),
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(payload.emittedCount).toBeLessThan(items.length)
    expect(Buffer.byteLength(payload.previewJson, 'utf16le')).toBeLessThanOrEqual(
      SUMMARY_JSON_MAX_UTF16_BYTES,
    )
  })
})
