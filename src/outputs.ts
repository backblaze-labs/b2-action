import { Buffer } from 'node:buffer'
import * as core from '@actions/core'

export const SUMMARY_JSON_PREVIEW_MAX_ENTRIES = 100
export const SUMMARY_JSON_MAX_UTF8_BYTES = 256 * 1024

export type SummaryJsonPayload = CompleteSummaryJsonPayload | TruncatedSummaryJsonPayload

export interface CompleteSummaryJsonPayload {
  json: string
  totalCount: number
  emittedCount: number
  truncated: false
}

export interface TruncatedSummaryJsonPayload {
  json: string
  previewJson: string
  totalCount: number
  emittedCount: number
  truncated: true
}

export interface SummaryJsonOutputOptions {
  previewItem?: (item: unknown) => unknown
}

/**
 * Serialize per-file command details into the bounded `summary-json` output.
 *
 * GitHub Actions writes outputs as UTF-8 and caps all action outputs for a job
 * at 1 MB. Keep this single structured output well below that job-level
 * budget so the scalar outputs and any caller-defined outputs still have room.
 *
 * `summary-json` remains a complete array when the full manifest fits. When a
 * result exceeds the supported byte cap, `summary-json` receives a small JSON
 * object describing the truncation, never a partial array or an empty string.
 * `summary-json-preview` receives a bounded diagnostic prefix,
 * `summary-json-truncated` is set to `true`, and the action step may still
 * succeed because the B2 operation itself has already completed. Scalar count
 * outputs (`file-count`, `files-listed`, etc.) remain the authoritative totals.
 */
export function buildSummaryJsonPayload(
  items: readonly unknown[],
  options: SummaryJsonOutputOptions = {},
): SummaryJsonPayload {
  try {
    const fullJson = JSON.stringify(items)
    if (utf8ByteLength(fullJson) <= SUMMARY_JSON_MAX_UTF8_BYTES) {
      return {
        json: fullJson,
        totalCount: items.length,
        emittedCount: items.length,
        truncated: false,
      }
    }
  } catch {
    return buildTruncatedSummaryJsonPayload(
      items,
      options,
      'summary-json could not be serialized within the supported output contract',
    )
  }

  return buildTruncatedSummaryJsonPayload(
    items,
    options,
    'summary-json exceeded the supported UTF-8 output size cap',
  )
}

function buildTruncatedSummaryJsonPayload(
  items: readonly unknown[],
  options: SummaryJsonOutputOptions,
  reason: string,
): TruncatedSummaryJsonPayload {
  const preview = buildSummaryJsonPreview(items, options)

  return {
    json: JSON.stringify({
      truncated: true,
      reason,
      totalCount: items.length,
      previewCount: preview.emittedCount,
      previewOutput: 'summary-json-preview',
    }),
    previewJson: preview.json,
    totalCount: items.length,
    emittedCount: preview.emittedCount,
    truncated: true,
  }
}

function buildSummaryJsonPreview(
  items: readonly unknown[],
  options: SummaryJsonOutputOptions,
): {
  json: string
  emittedCount: number
} {
  const cappedCount = Math.min(items.length, SUMMARY_JSON_PREVIEW_MAX_ENTRIES)
  let low = 0
  let high = cappedCount
  let emittedCount = 0
  let json = '[]'

  // Serialized JSON array length grows monotonically as prefix elements are
  // appended, so binary search the largest diagnostic prefix that fits.
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    let candidate: string
    try {
      candidate = JSON.stringify(previewItems(items, mid, options.previewItem))
    } catch {
      high = mid - 1
      continue
    }
    if (utf8ByteLength(candidate) <= SUMMARY_JSON_MAX_UTF8_BYTES) {
      emittedCount = mid
      json = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return { json, emittedCount }
}

export function setSummaryJsonOutput(
  items: readonly unknown[],
  options: SummaryJsonOutputOptions = {},
): void {
  const payload = buildSummaryJsonPayload(items, options)

  core.setOutput('summary-json-truncated', String(payload.truncated))
  core.setOutput('summary-json', payload.json)
  if (!payload.truncated) {
    return
  }

  core.setOutput('summary-json-preview', payload.previewJson)
  core.warning(
    `summary-json exceeds supported output limits; preview contains ` +
      `${payload.emittedCount} of ${payload.totalCount} item(s). ` +
      `summary-json contains a truncation notice instead of a partial manifest. ` +
      `limit is ${formatKiB(SUMMARY_JSON_MAX_UTF8_BYTES)} of UTF-8 JSON text`,
  )
}

function previewItems(
  items: readonly unknown[],
  count: number,
  previewItem: ((item: unknown) => unknown) | undefined,
): unknown[] {
  const slice = items.slice(0, count)
  return previewItem === undefined ? slice : slice.map(previewItem)
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function formatKiB(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}
