import type { DownloadCallOptions } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from './inputs.ts'

export type DownloadHeaderOverrides = Pick<
  DownloadCallOptions,
  'b2CacheControl' | 'b2ContentDisposition' | 'b2ContentType'
>

const DOWNLOAD_OVERRIDE_QUERY_PARAMS = {
  b2ContentDisposition: 'b2ContentDisposition',
  b2ContentType: 'b2ContentType',
  b2CacheControl: 'b2CacheControl',
} as const satisfies Record<keyof DownloadHeaderOverrides, string>

export function downloadHeaderOverridesFromInputs(inputs: ParsedInputs): DownloadHeaderOverrides {
  return {
    ...(inputs.contentDisposition !== undefined
      ? { b2ContentDisposition: inputs.contentDisposition }
      : {}),
    ...(inputs.responseContentType !== undefined
      ? { b2ContentType: inputs.responseContentType }
      : {}),
    ...(inputs.cacheControl !== undefined ? { b2CacheControl: inputs.cacheControl } : {}),
  }
}

export function appendDownloadHeaderOverrides(
  url: string,
  overrides: DownloadHeaderOverrides,
): string {
  const entries = Object.entries(DOWNLOAD_OVERRIDE_QUERY_PARAMS) as Array<
    [keyof DownloadHeaderOverrides, string]
  >
  if (entries.every(([key]) => overrides[key] === undefined)) return url

  const parsed = new URL(url)
  for (const [key, param] of entries) {
    const value = overrides[key]
    if (value !== undefined) {
      parsed.searchParams.set(param, value)
    }
  }
  return parsed.toString()
}
