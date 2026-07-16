import { Buffer } from 'node:buffer'
import * as core from '@actions/core'

export const SUMMARY_JSON_PREVIEW_MAX_ENTRIES = 100
export const SUMMARY_JSON_MAX_UTF8_BYTES = 256 * 1024
const SUMMARY_JSON_OUTPUT_NAME = 'summary-json'
const SUMMARY_JSON_TRUNCATED_OUTPUT_NAME = 'summary-json-truncated'
export const SUMMARY_JSON_NOTICE_OUTPUT_NAME = 'summary-json-notice'
export const SUMMARY_JSON_PREVIEW_OUTPUT_NAME = 'summary-json-preview'

export type SummaryJsonPayload = CompleteSummaryJsonPayload | TruncatedSummaryJsonPayload

export interface CompleteSummaryJsonPayload {
  json: string
  totalCount: number
  truncated: false
}

export interface TruncatedSummaryJsonPayload {
  json: string
  noticeJson: string
  previewJson: string
  totalCount: number
  previewCount: number
  reason: string
  truncated: true
}

export interface SummaryJsonOutputOptions<T> {
  item?: (item: T) => unknown
}

interface BoundedJsonArray {
  json: string
  emittedCount: number
  byteLimitExceeded: boolean
  serializationFailed: boolean
}

/**
 * Serialize per-file command details into the bounded `summary-json` output.
 *
 * GitHub Actions writes outputs as UTF-8 and caps all action outputs for a job
 * at 1 MB. Keep this single structured output well below that job-level
 * budget so scalar outputs, $GITHUB_OUTPUT framing, and caller-defined outputs
 * still have room.
 *
 * `summary-json` remains a complete array when the full manifest fits. When a
 * result exceeds the supported byte cap, `summary-json` remains an array
 * (`[]`) rather than changing shape or carrying a partial manifest.
 * `summary-json-notice` receives a small JSON object describing the
 * truncation, `summary-json-preview` receives a bounded diagnostic prefix, and
 * `summary-json-truncated` is set to `true`. The action step may still succeed
 * because the B2 operation itself has already completed. Scalar count outputs
 * (`file-count`, `files-listed`, etc.) remain the authoritative totals.
 *
 * The serializer also omits credential-bearing field names for every command:
 * `url`, fields ending in `url`, and fields containing `authorization`,
 * `signature`, or `token` after case/underscore/hyphen normalization. Common
 * credential field names such as `applicationKey`, `secret`, `secretKey`, and
 * `accessKey` are omitted too. Commands that need to expose similarly named
 * non-secret data should project it to an explicit safe field name before
 * calling this helper.
 */
export function buildSummaryJsonPayload<T>(
  items: readonly T[],
  options: SummaryJsonOutputOptions<T> = {},
): SummaryJsonPayload {
  const serialized = serializeJsonArrayPrefix(items, options, items.length)
  if (!serialized.byteLimitExceeded && !serialized.serializationFailed) {
    return {
      json: serialized.json,
      totalCount: items.length,
      truncated: false,
    }
  }

  return buildTruncatedSummaryJsonPayload(
    items,
    options,
    serialized.serializationFailed
      ? 'summary-json could not be serialized within the supported output contract'
      : 'summary-json exceeded the supported UTF-8 output size cap',
  )
}

function buildTruncatedSummaryJsonPayload<T>(
  items: readonly T[],
  options: SummaryJsonOutputOptions<T>,
  reason: string,
): TruncatedSummaryJsonPayload {
  const preview = buildSummaryJsonPreview(items, options)

  return {
    json: '[]',
    noticeJson: JSON.stringify({
      truncated: true,
      reason,
      totalCount: items.length,
      previewCount: preview.emittedCount,
      previewOutput: SUMMARY_JSON_PREVIEW_OUTPUT_NAME,
    }),
    previewJson: preview.json,
    totalCount: items.length,
    previewCount: preview.emittedCount,
    reason,
    truncated: true,
  }
}

function buildSummaryJsonPreview<T>(
  items: readonly T[],
  options: SummaryJsonOutputOptions<T>,
): {
  json: string
  emittedCount: number
} {
  const preview = serializeJsonArrayPrefix(items, options, SUMMARY_JSON_PREVIEW_MAX_ENTRIES)
  return { json: preview.json, emittedCount: preview.emittedCount }
}

export function setSummaryJsonOutput<T>(
  items: readonly T[],
  options: SummaryJsonOutputOptions<T> = {},
): void {
  const payload = buildSummaryJsonPayload(items, options)

  core.setOutput(SUMMARY_JSON_TRUNCATED_OUTPUT_NAME, String(payload.truncated))
  core.setOutput(SUMMARY_JSON_OUTPUT_NAME, payload.json)
  if (!payload.truncated) {
    return
  }

  core.setOutput(SUMMARY_JSON_NOTICE_OUTPUT_NAME, payload.noticeJson)
  core.setOutput(SUMMARY_JSON_PREVIEW_OUTPUT_NAME, payload.previewJson)
  core.warning(
    `summary-json truncated: ${payload.reason}; preview contains ` +
      `${payload.previewCount} of ${payload.totalCount} item(s). ` +
      `summary-json is [] and summary-json-notice describes the truncation. ` +
      `limit is ${formatKiB(SUMMARY_JSON_MAX_UTF8_BYTES)} of UTF-8 JSON text`,
  )
}

function serializeJsonArrayPrefix<T>(
  items: readonly T[],
  options: SummaryJsonOutputOptions<T>,
  maxEntries: number,
): BoundedJsonArray {
  const parts: string[] = ['[']
  let bytes = 2
  let emittedCount = 0
  const count = Math.min(items.length, maxEntries)

  for (let index = 0; index < count; index++) {
    let itemJson: string
    try {
      itemJson = stringifyArrayItem(projectItem(items[index] as T, options))
    } catch {
      parts.push(']')
      return {
        json: parts.join(''),
        emittedCount,
        byteLimitExceeded: false,
        serializationFailed: true,
      }
    }

    const separator = emittedCount === 0 ? '' : ','
    const additionalBytes = utf8ByteLength(separator) + utf8ByteLength(itemJson)
    if (bytes + additionalBytes > SUMMARY_JSON_MAX_UTF8_BYTES) {
      parts.push(']')
      return {
        json: parts.join(''),
        emittedCount,
        byteLimitExceeded: true,
        serializationFailed: false,
      }
    }

    if (separator !== '') parts.push(separator)
    parts.push(itemJson)
    bytes += additionalBytes
    emittedCount++
  }

  parts.push(']')
  return {
    json: parts.join(''),
    emittedCount,
    byteLimitExceeded: false,
    serializationFailed: false,
  }
}

function projectItem<T>(item: T, options: SummaryJsonOutputOptions<T>): unknown {
  return options.item === undefined ? item : options.item(item)
}

function stringifyArrayItem(item: unknown): string {
  const json = JSON.stringify(item, sensitiveSummaryJsonFieldReplacer)
  return json === undefined ? 'null' : json
}

function sensitiveSummaryJsonFieldReplacer(key: string, value: unknown): unknown {
  return key !== '' && isSensitiveSummaryJsonField(key) ? undefined : value
}

function isSensitiveSummaryJsonField(key: string): boolean {
  const normalized = key.replaceAll('-', '').replaceAll('_', '').toLowerCase()
  return (
    normalized === 'url' ||
    normalized.endsWith('url') ||
    normalized.includes('authorization') ||
    normalized.includes('signature') ||
    normalized.includes('token') ||
    normalized === 'applicationkey' ||
    normalized === 'secret' ||
    normalized === 'secretkey' ||
    normalized === 'accesskey' ||
    normalized.endsWith('secret') ||
    normalized.endsWith('secretkey')
  )
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function formatKiB(bytes: number): string {
  return `${Math.floor(bytes / 1024)} KiB`
}
