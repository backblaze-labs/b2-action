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
const MUTATING_RETRY_SUFFIX =
  'action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes.'
const UNKNOWN_RETRY_HINT =
  'retry may be appropriate after checking whether the request had side effects.'
const READ_ONLY_ACTIONS = new Set<ActionName>(['download', 'list', 'presign', 'verify', 'head'])
const MAX_LOG_FIELD_LENGTH = 1_000

export interface ActionErrorOptions {
  action?: ActionName | undefined
  secretValues?: readonly string[] | undefined
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
    return failure(
      `B2 endpoint safety check failed: ${sanitizeLogField(err.message, options)}. Check the endpoint input and B2 realm configuration.`,
      false,
    )
  }
  if (err instanceof NetworkError) {
    return failure(
      `Transient network error talking to B2: ${retryHint(options.action)} ${sanitizeLogField(err.message, options)}`,
      true,
    )
  }
  if (err instanceof B2Error && err.retryable) {
    return failure(
      `Transient B2 error: ${retryHint(options.action)} ${formatB2Details(err, options)}`,
      true,
      err.retryAfter,
    )
  }
  if (err instanceof B2Error) {
    return failure(`B2 request failed: ${formatB2Details(err, options)}`, false, err.retryAfter)
  }
  const message = err instanceof Error ? err.message : String(err)
  return failure(sanitizeLogField(message, options), undefined)
}

export function formatActionError(err: unknown, options: ActionErrorOptions = {}): string {
  return classifyActionError(err, options).message
}

function failure(
  message: string,
  retryable: boolean | undefined,
  retryAfter?: number | undefined,
): ClassifiedActionError {
  return { message, retryable, retryAfter }
}

function formatB2Details(err: B2Error, options: ActionErrorOptions): string {
  const details = [
    `status ${sanitizeLogField(String(err.status), options)}`,
    `code ${sanitizeLogField(err.code, options)}`,
  ]
  if (err.requestId !== undefined) {
    details.push(`request ${sanitizeLogField(err.requestId, options)}`)
  }
  if (err.retryAfter !== undefined) {
    details.push(`retry after ${sanitizeLogField(String(err.retryAfter), options)}s`)
  }
  return `B2 said: ${sanitizeLogField(err.message, options)} (${details.join(', ')})`
}

function retryHint(action: ActionName | undefined): string {
  if (action !== undefined && READ_ONLY_ACTIONS.has(action)) return SAFE_RETRY_HINT
  if (action !== undefined) return `the ${action} ${MUTATING_RETRY_SUFFIX}`
  return UNKNOWN_RETRY_HINT
}

function sanitizeLogField(value: string, options: ActionErrorOptions): string {
  const secretValues = options.secretValues ?? []
  let sanitized = value
  for (const secret of secretValues) {
    if (secret !== '') sanitized = sanitized.split(secret).join('***')
  }
  if (sanitized.length <= MAX_LOG_FIELD_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_LOG_FIELD_LENGTH)}... [truncated]`
}
