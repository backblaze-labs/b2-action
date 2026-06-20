import {
  AccessDeniedError,
  B2Error,
  B2InsufficientCapabilityError,
  B2SsrfError,
  BadAuthTokenError,
  NetworkError,
} from '@backblaze-labs/b2-sdk/errors'
import { ACTION_EFFECTS, type ActionName } from './inputs.ts'

const SAFE_RETRY_HINT = 'safe to retry this workflow.'
const DRY_RUN_RETRY_HINT = 'safe to retry this dry-run workflow.'
const MUTATING_RETRY_SUFFIX =
  'action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes.'
const UNKNOWN_RETRY_HINT =
  'retry may be appropriate after checking whether the request had side effects.'
const SSRF_FAILURE_MESSAGE =
  'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.'
const MAX_LOG_FIELD_LENGTH = 1_000
const MAX_LOG_INPUT_LENGTH = MAX_LOG_FIELD_LENGTH * 2
const MAX_SECRET_BOUNDARY_WINDOW = MAX_LOG_INPUT_LENGTH
const MAX_DERIVED_SECRET_LENGTH = 512
const DEFAULT_NETWORK_RETRY_AFTER_SECONDS = 30
const MAX_RETRY_AFTER_SECONDS = 3_600
const MAX_CAUSE_DEPTH = 32

export interface ActionErrorOptions {
  action?: ActionName
  dryRun?: boolean
  secretValues?: readonly string[]
}

export interface ClassifiedActionError {
  message: string
  retryable: boolean | undefined
  retryAfter: number | undefined
}

export function classifyActionError(
  err: unknown,
  options: ActionErrorOptions = {},
): ClassifiedActionError {
  // Order matters: specific SDK classes first, then retryable B2Error, then
  // the generic B2Error fallback last so new subclasses are not shadowed.
  if (hasSsrfCause(err)) {
    return failure(SSRF_FAILURE_MESSAGE, false)
  }
  if (err instanceof BadAuthTokenError && isAuthorizationScopeFailure(err)) {
    return failure(
      `B2 permission denied: application key is missing required capabilities or is outside the bucket/prefix scope. Update the key capabilities or use a key scoped to this bucket/prefix. ${formatB2Details(err, options)}`,
      false,
    )
  }
  if (err instanceof BadAuthTokenError) {
    return failure(
      `B2 authentication failed: check application-key-id and application-key, and confirm the key is active. ${formatB2Details(err, options)}`,
      false,
    )
  }
  if (err instanceof B2InsufficientCapabilityError) {
    const missing = err.missing.length > 0 ? err.missing.join(', ') : '(unknown)'
    return failure(
      `B2 permission denied: application key is missing required capabilities: ${sanitizeLogField(missing, options)}. Update the key capabilities or use a key scoped to this bucket/prefix.`,
      false,
    )
  }
  if (err instanceof AccessDeniedError) {
    return failure(
      `B2 permission denied: check application key capabilities, bucket access, and file name prefix restrictions. ${formatB2Details(err, options)}`,
      false,
    )
  }
  if (err instanceof NetworkError) {
    const retry = retryPolicy(options)
    return failure(
      `Transient network error talking to B2: ${retry.hint} ${sanitizeLogField(err.message, options)}`,
      retry.safe,
      retry.safe ? DEFAULT_NETWORK_RETRY_AFTER_SECONDS : undefined,
    )
  }
  if (err instanceof B2Error && err.retryable) {
    const retry = retryPolicy(options)
    return failure(
      `Transient B2 error: ${retry.hint} ${formatB2Details(err, options)}`,
      retry.safe,
      retry.safe ? err.retryAfter : undefined,
    )
  }
  if (err instanceof B2Error) {
    return failure(
      `B2 request failed: ${formatGenericB2Guidance(err, options)} ${formatB2Details(err, options)}`,
      false,
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return failure(sanitizeLogField(message, options), undefined)
}

export function formatActionDebugError(err: unknown, options: ActionErrorOptions = {}): string {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
  return sanitizeLogField(message, options)
}

function failure(
  message: string,
  retryable: boolean | undefined,
  retryAfter?: number | undefined,
): ClassifiedActionError {
  return { message, retryable, retryAfter: normalizeRetryAfter(retryAfter) }
}

function formatB2Details(err: B2Error, options: ActionErrorOptions): string {
  const details = [
    `status ${sanitizeLogField(String(err.status), options)}`,
    `code ${sanitizeLogField(err.code, options)}`,
  ]
  const retryAfter = normalizeRetryAfter(err.retryAfter)
  if (retryAfter !== undefined) {
    details.push(`retry after ${sanitizeLogField(String(retryAfter), options)}s`)
  }
  return `B2 response details: ${details.join(', ')}`
}

function formatGenericB2Guidance(err: B2Error, options: ActionErrorOptions): string {
  const message = sanitizeLogField(err.message, options)
  switch (err.code) {
    case 'file_not_present':
    case 'no_such_file':
      return `File not found; check the bucket and file name. B2 said: ${message}.`
    case 'duplicate_bucket_name':
      return `Bucket name already exists; choose a unique bucket name. B2 said: ${message}.`
    case 'cap_exceeded':
    case 'storage_cap_exceeded':
    case 'transaction_cap_exceeded':
    case 'download_cap_exceeded':
      return `B2 account cap was exceeded; reduce usage or wait before retrying. B2 said: ${message}.`
    case 'bad_request':
      return `Bad request; check the action inputs for invalid values. B2 said: ${message}.`
    default:
      return `B2 said: ${message}.`
  }
}

function retryPolicy(options: ActionErrorOptions): { safe: boolean; hint: string } {
  const { action } = options
  if (action === undefined) return { safe: false, hint: UNKNOWN_RETRY_HINT }
  const effect = ACTION_EFFECTS[action]
  if (options.dryRun === true && effect.honorsDryRun) {
    return { safe: true, hint: DRY_RUN_RETRY_HINT }
  }
  if (effect.kind === 'read') return { safe: true, hint: SAFE_RETRY_HINT }
  return { safe: false, hint: `the ${action} ${MUTATING_RETRY_SUFFIX}` }
}

function isAuthorizationScopeFailure(err: BadAuthTokenError): boolean {
  if (err.code !== 'unauthorized') return false
  // The SDK currently exposes scoped-key `unauthorized` responses as
  // BadAuthTokenError with only server prose to distinguish capability/scope
  // misses. Keep this as best-effort until a structured subtype exists.
  return /\b(capability|capabilities|scope|bucket|prefix|permission|not authorized|unauthorized)\b/i.test(
    err.message,
  )
}

function hasSsrfCause(err: unknown): boolean {
  const seen = new Set<Error>()
  let current: unknown = err
  for (let depth = 0; current instanceof Error && depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (current instanceof B2SsrfError) return true
    if (seen.has(current)) return false
    seen.add(current)
    current = current.cause
  }
  return false
}

function normalizeRetryAfter(retryAfter: number | undefined): number | undefined {
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter < 0) return undefined
  return Math.min(Math.ceil(retryAfter), MAX_RETRY_AFTER_SECONDS)
}

function sanitizeUntrustedText(value: string): string {
  return value
    .replace(/\bhttps?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
}

function sanitizeLogField(value: string, options: ActionErrorOptions): string {
  const secretValues = options.secretValues ?? []
  const scrubInputLength =
    secretValues.length > 0
      ? MAX_LOG_INPUT_LENGTH + MAX_SECRET_BOUNDARY_WINDOW
      : MAX_LOG_INPUT_LENGTH
  const bounded = value.length > scrubInputLength ? value.slice(0, scrubInputLength) : value
  const masked = maskSecrets(bounded, secretValues)
  const scrubbed =
    masked.length > MAX_LOG_INPUT_LENGTH ? masked.slice(0, MAX_LOG_INPUT_LENGTH) : masked
  const sanitized = sanitizeUntrustedText(scrubbed)
  if (sanitized.length <= MAX_LOG_FIELD_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_LOG_FIELD_LENGTH)}... [truncated]`
}

function maskSecrets(value: string, secretValues: readonly string[]): string {
  let masked = value
  for (const secret of secretValues) {
    for (const variant of secretVariants(secret)) {
      masked = masked.split(variant).join('***')
    }
  }
  return masked
}

function secretVariants(secret: string): string[] {
  if (secret === '') return []
  const variants = new Set<string>()
  addSecretVariant(variants, secret)
  if (secret.length > MAX_LOG_INPUT_LENGTH) {
    addSecretVariant(variants, secret.slice(0, MAX_LOG_INPUT_LENGTH))
  }
  if (secret.length >= 4 && secret.length <= MAX_DERIVED_SECRET_LENGTH) {
    const base64 = Buffer.from(secret, 'utf8').toString('base64')
    const base64Url = base64.replaceAll('+', '-').replaceAll('/', '_')
    addUriEncodedSecretVariant(variants, secret)
    addSecretVariant(variants, base64)
    addSecretVariant(variants, base64Url)
    addSecretVariant(variants, base64Url.replace(/=+$/u, ''))
    addSecretVariant(variants, Buffer.from(secret, 'utf8').toString('hex'))
  }
  return [...variants].sort((a, b) => b.length - a.length)
}

function addSecretVariant(variants: Set<string>, value: string): void {
  if (value !== '') variants.add(value)
}

function addUriEncodedSecretVariant(variants: Set<string>, secret: string): void {
  try {
    addSecretVariant(variants, encodeURIComponent(secret))
  } catch {
    // Malformed surrogate pairs are valid JavaScript strings but invalid URI
    // components. Keep raw/base64/hex masking without letting scrubbing fail.
  }
}
