import {
  AccessDeniedError,
  B2Error,
  B2InsufficientCapabilityError,
  B2SsrfError,
  BadAuthTokenError,
  NetworkError,
} from '@backblaze-labs/b2-sdk/errors'
import type { ActionName } from './inputs.ts'

const SAFE_RETRY_HINT = 'safe to retry this workflow.'
const DRY_RUN_RETRY_HINT = 'safe to retry this dry-run workflow.'
const MUTATING_RETRY_SUFFIX =
  'action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes.'
const UNKNOWN_RETRY_HINT =
  'retry may be appropriate after checking whether the request had side effects.'
const SSRF_FAILURE_MESSAGE =
  'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.'
// New actions must be assessed here. The fail-safe default for unlisted actions
// is the mutating-action retry warning and retryable=false structured output.
const READ_ONLY_ACTIONS = new Set<ActionName>(['download', 'list', 'presign', 'verify', 'head'])
const MAX_LOG_FIELD_LENGTH = 1_000
const DEFAULT_NETWORK_RETRY_AFTER_SECONDS = 30
const MAX_RETRY_AFTER_SECONDS = 3_600

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
  if (hasCause(err, B2SsrfError)) {
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
  if (err instanceof B2SsrfError) {
    return failure(SSRF_FAILURE_MESSAGE, false)
  }
  if (err instanceof NetworkError) {
    const retryable = isSafeToRetry(options)
    return failure(
      `Transient network error talking to B2: ${retryHint(options)} ${sanitizeLogField(err.message, options)}`,
      retryable,
      retryable ? DEFAULT_NETWORK_RETRY_AFTER_SECONDS : undefined,
    )
  }
  if (err instanceof B2Error && err.retryable) {
    const retryable = isSafeToRetry(options)
    return failure(
      `Transient B2 error: ${retryHint(options)} ${formatB2Details(err, options)}`,
      retryable,
      retryable ? err.retryAfter : undefined,
    )
  }
  if (err instanceof B2Error) {
    return failure(`B2 request failed: ${formatB2Details(err, options)}`, false)
  }
  const message = err instanceof Error ? err.message : String(err)
  return failure(sanitizeLogField(message, options), undefined)
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

function retryHint(options: ActionErrorOptions): string {
  if (options.dryRun === true) return DRY_RUN_RETRY_HINT
  const { action } = options
  if (action === undefined) return UNKNOWN_RETRY_HINT
  return READ_ONLY_ACTIONS.has(action) ? SAFE_RETRY_HINT : `the ${action} ${MUTATING_RETRY_SUFFIX}`
}

function isSafeToRetry(options: ActionErrorOptions): boolean {
  if (options.dryRun === true) return true
  const { action } = options
  return action !== undefined && READ_ONLY_ACTIONS.has(action)
}

function isAuthorizationScopeFailure(err: BadAuthTokenError): boolean {
  if (err.code !== 'unauthorized') return false
  return /\b(capability|capabilities|scope|bucket|prefix|permission|not authorized|unauthorized)\b/i.test(
    err.message,
  )
}

function hasCause(err: unknown, errorClass: typeof B2SsrfError): boolean {
  let current: unknown = err
  while (current instanceof Error) {
    if (current instanceof errorClass) return true
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
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]')
}

function sanitizeLogField(value: string, options: ActionErrorOptions): string {
  const secretValues = options.secretValues ?? []
  let sanitized = sanitizeUntrustedText(value)
  for (const secret of secretValues) {
    if (secret !== '') sanitized = sanitized.split(secret).join('***')
  }
  if (sanitized.length <= MAX_LOG_FIELD_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_LOG_FIELD_LENGTH)}... [truncated]`
}
