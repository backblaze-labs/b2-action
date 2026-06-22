import { Buffer } from 'node:buffer'
import * as core from '@actions/core'

export const SUMMARY_JSON_MAX_ENTRIES = 100
export const SUMMARY_JSON_MAX_UTF16_BYTES = 256 * 1024

export type SummaryJsonPayload = CompleteSummaryJsonPayload | TruncatedSummaryJsonPayload

export interface CompleteSummaryJsonPayload {
  json: string
  totalCount: number
  emittedCount: number
  truncated: false
}

export interface TruncatedSummaryJsonPayload {
  previewJson: string
  totalCount: number
  emittedCount: number
  truncated: true
}

/**
 * Serialize per-file command details into the bounded `summary-json` output.
 *
 * GitHub Actions caps all action outputs for a job at 1 MB, approximated with
 * UTF-16 size. Keep this single structured output well below that job-level
 * budget so the scalar outputs and any caller-defined outputs still have room.
 *
 * `summary-json` is complete-or-error: callers never receive a successful,
 * partial value under that legacy output name. When a result exceeds the
 * supported cap, `summary-json-preview` receives the bounded prefix,
 * `summary-json-truncated` is set to `true`, and the action fails so existing
 * manifest consumers cannot silently process an incomplete array. Scalar count
 * outputs (`file-count`, `files-listed`, etc.) remain the authoritative totals.
 */
export function buildSummaryJsonPayload(items: readonly unknown[]): SummaryJsonPayload {
  if (items.length <= SUMMARY_JSON_MAX_ENTRIES) {
    const fullJson = JSON.stringify(items)
    if (utf16ByteLength(fullJson) <= SUMMARY_JSON_MAX_UTF16_BYTES) {
      return {
        json: fullJson,
        totalCount: items.length,
        emittedCount: items.length,
        truncated: false,
      }
    }
  }

  const preview = buildSummaryJsonPreview(items)

  return {
    previewJson: preview.json,
    totalCount: items.length,
    emittedCount: preview.emittedCount,
    truncated: true,
  }
}

function buildSummaryJsonPreview(items: readonly unknown[]): {
  json: string
  emittedCount: number
} {
  const cappedCount = Math.min(items.length, SUMMARY_JSON_MAX_ENTRIES)
  let low = 0
  let high = cappedCount
  let emittedCount = 0
  let json = '[]'

  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = JSON.stringify(items.slice(0, mid))
    if (utf16ByteLength(candidate) <= SUMMARY_JSON_MAX_UTF16_BYTES) {
      emittedCount = mid
      json = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return { json, emittedCount }
}

export function setSummaryJsonOutput(items: readonly unknown[]): void {
  const payload = buildSummaryJsonPayload(items)

  core.setOutput('summary-json-truncated', String(payload.truncated))
  if (!payload.truncated) {
    core.setOutput('summary-json', payload.json)
    return
  }

  core.setOutput('summary-json-preview', payload.previewJson)
  core.warning(
    `summary-json exceeds supported output limits; preview contains ` +
      `${payload.emittedCount} of ${payload.totalCount} item(s). ` +
      `limit is ${SUMMARY_JSON_MAX_ENTRIES} entries and ${formatKiB(
        SUMMARY_JSON_MAX_UTF16_BYTES,
      )} of UTF-16 JSON text`,
  )
  throw new Error(
    `summary-json exceeds supported output limits: ${payload.totalCount} item(s) cannot fit ` +
      `within ${SUMMARY_JSON_MAX_ENTRIES} entries and ${formatKiB(
        SUMMARY_JSON_MAX_UTF16_BYTES,
      )} of UTF-16 JSON text. Refusing to emit a partial summary-json value; ` +
      `use file-count or verb-specific counts for totals and summary-json-preview only after ` +
      `checking summary-json-truncated.`,
  )
}

function utf16ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf16le')
}

function formatKiB(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}
