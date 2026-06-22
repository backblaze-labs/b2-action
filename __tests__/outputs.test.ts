import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  buildSummaryJsonPayload,
  SUMMARY_JSON_MAX_UTF8_BYTES,
  SUMMARY_JSON_PREVIEW_MAX_ENTRIES,
  SUMMARY_JSON_PREVIEW_OUTPUT_NAME,
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

  it('keeps payloads over the preview count complete when they fit the byte cap', () => {
    const items = Array.from({ length: SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5 }, (_, i) => ({
      fileName: `file-${i}.txt`,
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(false)
    if (payload.truncated) throw new Error('expected complete payload')
    expect(payload.totalCount).toBe(SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5)
    expect(payload.emittedCount).toBe(SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5)
    expect(JSON.parse(payload.json)).toHaveLength(SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5)
  })

  it('emits a truncation notice and preview for oversized UTF-8 payloads', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      fileName: `large-${i}.txt`,
      metadata: 'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES),
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(Array.isArray(JSON.parse(payload.json))).toBe(false)
    expect(JSON.parse(payload.json)).toMatchObject({
      truncated: true,
      totalCount: items.length,
      previewOutput: SUMMARY_JSON_PREVIEW_OUTPUT_NAME,
    })
    expect(payload.emittedCount).toBeLessThan(items.length)
    expect(Buffer.byteLength(payload.previewJson, 'utf8')).toBeLessThanOrEqual(
      SUMMARY_JSON_MAX_UTF8_BYTES,
    )
  })

  it('keeps UTF-8 output within the cap for multibyte filenames', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({
      fileName: `${'\u4e00'.repeat(2000)}-${i}`,
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(Buffer.byteLength(payload.previewJson, 'utf8')).toBeLessThanOrEqual(
      SUMMARY_JSON_MAX_UTF8_BYTES,
    )
  })

  it('handles an oversized first item with an empty preview', () => {
    const items = [{ fileName: 'huge.txt', metadata: 'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES) }]

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(payload.emittedCount).toBe(0)
    expect(payload.previewJson).toBe('[]')
    expect(JSON.parse(payload.json)).toMatchObject({ truncated: true, previewCount: 0 })
  })

  it('emits a truncation notice when the full manifest cannot be serialized', () => {
    const circular: Record<string, unknown> = { fileName: 'bad.txt' }
    circular.self = circular
    const items = [{ fileName: 'safe.txt' }, circular]

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(JSON.parse(payload.json)).toMatchObject({
      truncated: true,
      reason: 'summary-json could not be serialized within the supported output contract',
      totalCount: items.length,
      previewCount: 1,
    })
    expect(JSON.parse(payload.previewJson)).toEqual([{ fileName: 'safe.txt' }])
  })

  it('stops serializing oversized manifests after a bounded prefix', () => {
    let serializedCount = 0
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      toJSON() {
        serializedCount++
        return {
          fileName: `hostile-${i}.txt`,
          metadata: 'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES),
        }
      },
    }))

    const payload = buildSummaryJsonPayload(items)

    expect(payload.truncated).toBe(true)
    expect(serializedCount).toBeLessThan(10)
    expect(JSON.parse(payload.json)).toMatchObject({
      truncated: true,
      totalCount: items.length,
      previewCount: 0,
    })
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(payload.previewJson).toBe('[]')
  })

  it('applies item projections before emitting complete payloads', () => {
    const items = [
      {
        fileName: 'secret.txt',
        url: 'https://download.example/secret',
        expiresAt: 1_900_000_000,
      },
    ]

    const payload = buildSummaryJsonPayload(items, {
      item(item) {
        return {
          fileName: item.fileName,
          expiresAt: item.expiresAt,
        }
      },
    })

    expect(payload.truncated).toBe(false)
    if (payload.truncated) throw new Error('expected complete payload')
    expect(payload.json).not.toContain('https://download.example')
    expect(JSON.parse(payload.json)).toEqual([{ fileName: 'secret.txt', expiresAt: 1_900_000_000 }])
  })

  it('applies item projections before emitting bounded previews', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      fileName: `secret-${i}.txt`,
      url: `https://download.example/secret-${i}`,
      metadata: 'x'.repeat(Math.floor(SUMMARY_JSON_MAX_UTF8_BYTES / 2)),
    }))

    const payload = buildSummaryJsonPayload(items, {
      item(item) {
        const clone = { ...(item as Record<string, unknown>) }
        delete clone.url
        return clone
      },
    })

    expect(payload.truncated).toBe(true)
    if (!payload.truncated) throw new Error('expected truncated payload')
    expect(payload.previewJson).not.toContain('https://download.example')
    expect(JSON.parse(payload.previewJson)).toEqual([
      {
        fileName: 'secret-0.txt',
        metadata: 'x'.repeat(Math.floor(SUMMARY_JSON_MAX_UTF8_BYTES / 2)),
      },
    ])
  })
})
