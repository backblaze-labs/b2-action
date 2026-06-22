import { Buffer } from 'node:buffer'
import * as core from '@actions/core'

export const SUMMARY_JSON_MAX_ENTRIES = 100
export const SUMMARY_JSON_MAX_UTF16_BYTES = 256 * 1024

export interface SummaryJsonPayload {
  json: string
  totalCount: number
  emittedCount: number
  truncated: boolean
}

/**
 * Serialize per-file command details into the bounded `summary-json` output.
 *
 * GitHub Actions caps all action outputs for a job at 1 MB, approximated with
 * UTF-16 size. Keep this single structured output well below that job-level
 * budget so the scalar outputs and any caller-defined outputs still have room.
 */
export function buildSummaryJsonPayload(items: readonly unknown[]): SummaryJsonPayload {
  const cappedCount = Math.min(items.length, SUMMARY_JSON_MAX_ENTRIES)
  const cappedJson = JSON.stringify(items.slice(0, cappedCount))

  if (utf16ByteLength(cappedJson) <= SUMMARY_JSON_MAX_UTF16_BYTES) {
    return {
      json: cappedJson,
      totalCount: items.length,
      emittedCount: cappedCount,
      truncated: cappedCount < items.length,
    }
  }

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

  return {
    json,
    totalCount: items.length,
    emittedCount,
    truncated: emittedCount < items.length,
  }
}

export function setSummaryJsonOutput(items: readonly unknown[]): void {
  const payload = buildSummaryJsonPayload(items)

  core.setOutput('summary-json', payload.json)
  if (!payload.truncated) return

  core.setOutput('summary-json-truncated', 'true')
  core.warning(
    `summary-json truncated to ${payload.emittedCount} of ${payload.totalCount} item(s); ` +
      `limit is ${SUMMARY_JSON_MAX_ENTRIES} entries and ${formatKiB(
        SUMMARY_JSON_MAX_UTF16_BYTES,
      )} of UTF-16 JSON text`,
  )
}

function utf16ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf16le')
}

function formatKiB(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}
