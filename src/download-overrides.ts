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

const HTTP_TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
const MAX_CONTENT_DISPOSITION_LENGTH = 1024
const MAX_CONTENT_TYPE_LENGTH = 255
const MAX_CACHE_CONTROL_LENGTH = 1024

export function downloadHeaderOverridesFromInputs(inputs: ParsedInputs): DownloadHeaderOverrides {
  const contentDisposition = validateContentDisposition(inputs.responseContentDisposition)
  const contentType = validateContentType(inputs.responseContentType)
  const cacheControl = validateCacheControl(inputs.responseCacheControl)

  return {
    ...(contentDisposition !== undefined ? { b2ContentDisposition: contentDisposition } : {}),
    ...(contentType !== undefined ? { b2ContentType: contentType } : {}),
    ...(cacheControl !== undefined ? { b2CacheControl: cacheControl } : {}),
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

function validateContentDisposition(value: string | undefined): string | undefined {
  return validateHeaderValue(
    'response-content-disposition',
    value,
    MAX_CONTENT_DISPOSITION_LENGTH,
    isContentDisposition,
    'must start with a disposition token and contain only valid parameters',
  )
}

function validateContentType(value: string | undefined): string | undefined {
  return validateHeaderValue(
    'response-content-type',
    value,
    MAX_CONTENT_TYPE_LENGTH,
    isContentType,
    'must be a media type such as application/pdf, with optional valid parameters',
  )
}

function validateCacheControl(value: string | undefined): string | undefined {
  return validateHeaderValue(
    'response-cache-control',
    value,
    MAX_CACHE_CONTROL_LENGTH,
    isCacheControl,
    'must contain comma-separated Cache-Control directives',
  )
}

function validateHeaderValue(
  inputName: string,
  value: string | undefined,
  maxLength: number,
  isValidFormat: (value: string) => boolean,
  formatDescription: string,
): string | undefined {
  if (value === undefined) return undefined
  if (value.length > maxLength) {
    throw new Error(`Invalid '${inputName}' input: must be at most ${maxLength} characters`)
  }
  if (containsHttpControlCharacter(value)) {
    throw new Error(`Invalid '${inputName}' input: must not contain HTTP control characters`)
  }
  if (!isValidFormat(value)) {
    throw new Error(`Invalid '${inputName}' input: ${formatDescription}`)
  }
  return value
}

function containsHttpControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isContentDisposition(value: string): boolean {
  const parts = splitOutsideQuotes(value, ';')
  if (parts === null || parts.length === 0 || !isHttpToken(parts[0])) return false
  return parts.slice(1).every(isParameter)
}

function isContentType(value: string): boolean {
  const parts = splitOutsideQuotes(value, ';')
  if (parts === null || parts.length === 0) return false

  const [type, subtype, ...extra] = parts[0]?.split('/') ?? []
  if (extra.length > 0 || !isHttpToken(type) || !isHttpToken(subtype)) return false
  return parts.slice(1).every(isParameter)
}

function isCacheControl(value: string): boolean {
  const directives = splitOutsideQuotes(value, ',')
  if (directives === null || directives.length === 0) return false
  return directives.every((directive) => {
    if (directive === '') return false
    const equals = directive.indexOf('=')
    if (equals === -1) return isHttpToken(directive)

    const name = directive.slice(0, equals).trim()
    const rawValue = directive.slice(equals + 1).trim()
    return isHttpToken(name) && isHeaderParameterValue(rawValue)
  })
}

function isParameter(value: string): boolean {
  const equals = value.indexOf('=')
  if (equals <= 0) return false

  const name = value.slice(0, equals).trim()
  const rawValue = value.slice(equals + 1).trim()
  return isHttpToken(name) && isHeaderParameterValue(rawValue)
}

function isHeaderParameterValue(value: string): boolean {
  return isHttpToken(value) || isQuotedString(value)
}

function isHttpToken(value: string | undefined): boolean {
  return value !== undefined && HTTP_TOKEN_RE.test(value)
}

function isQuotedString(value: string): boolean {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return false
  for (let i = 1; i < value.length - 1; i += 1) {
    const char = value[i]
    if (char === '"') return false
    if (char === '\\') {
      i += 1
      if (i >= value.length - 1) return false
    }
  }
  return true
}

function splitOutsideQuotes(value: string, separator: ';' | ','): string[] | null {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (quoted && char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && char === separator) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }

  if (quoted || escaped) return null
  parts.push(value.slice(start).trim())
  return parts
}
