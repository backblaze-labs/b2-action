import {
  AccessDeniedError,
  B2Error,
  B2InsufficientCapabilityError,
  B2SsrfError,
  BadAuthTokenError,
  ExpiredAuthTokenError,
  NetworkError,
  ServiceUnavailableError,
} from '@backblaze-labs/b2-sdk/errors'
import { describe, expect, it } from 'vitest'
import { classifyActionError, formatActionError } from '../src/errors.ts'

describe('formatActionError', () => {
  it('classifies B2 authentication failures with credential guidance', () => {
    const error = new BadAuthTokenError(
      { status: 401, code: 'bad_auth_token', message: 'bad auth token' },
      { requestId: 'auth-request' },
    )

    expect(formatActionError(error)).toBe(
      'B2 authentication failed: check application-key-id and application-key, and confirm the key is active. B2 said: bad auth token (status 401, code bad_auth_token, request auth-request)',
    )
  })

  it('classifies missing capabilities as permission failures', () => {
    const error = new B2InsufficientCapabilityError(
      ['listFiles', 'writeFiles'],
      ['listFiles'],
      ['writeFiles'],
    )

    expect(formatActionError(error)).toBe(
      'B2 permission denied: application key is missing required capabilities: writeFiles. Update the key capabilities or use a key scoped to this bucket/prefix.',
    )
  })

  it('classifies B2 access denied errors as permission failures', () => {
    const error = new AccessDeniedError(
      { status: 403, code: 'access_denied', message: 'prefix is not allowed' },
      { requestId: 'access-request' },
    )

    expect(formatActionError(error)).toBe(
      'B2 permission denied: check application key capabilities, bucket access, and file name prefix restrictions. B2 said: prefix is not allowed (status 403, code access_denied, request access-request)',
    )
  })

  it('uses read-only retry guidance only for read-side actions', () => {
    const message = formatActionError(new NetworkError('fetch failed'), { action: 'list' })

    expect(message).toBe(
      'Transient network error talking to B2: safe to retry this workflow. fetch failed',
    )
  })

  it('uses conservative retry guidance for mutating actions', () => {
    const message = formatActionError(new NetworkError('fetch failed'), { action: 'upload' })

    expect(message).toBe(
      'Transient network error talking to B2: the upload action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes. fetch failed',
    )
  })

  it('classifies retryable B2 API errors as transient failures', () => {
    const result = classifyActionError(
      new ServiceUnavailableError(
        { status: 503, code: 'service_unavailable', message: 'try again later' },
        { retryAfter: 30, requestId: 'retry-request' },
      ),
      { action: 'download' },
    )

    expect(result).toEqual({
      message:
        'Transient B2 error: safe to retry this workflow. B2 said: try again later (status 503, code service_unavailable, request retry-request, retry after 30s)',
      retryable: true,
      retryAfter: 30,
    })
  })

  it('keeps expired auth token errors in the transient category', () => {
    const message = formatActionError(
      new ExpiredAuthTokenError({
        status: 401,
        code: 'expired_auth_token',
        message: 'expired token',
      }),
      { action: 'head' },
    )

    expect(message).toBe(
      'Transient B2 error: safe to retry this workflow. B2 said: expired token (status 401, code expired_auth_token)',
    )
  })

  it('classifies endpoint safety failures before retryable B2 errors', () => {
    const message = formatActionError(
      new B2SsrfError(
        'rejected upload URL http://169.254.169.254/latest',
        'http://169.254.169.254',
      ),
    )

    expect(message).toBe(
      'B2 endpoint safety check failed: rejected upload URL http://169.254.169.254/latest. Check the endpoint input and B2 realm configuration.',
    )
  })

  it('classifies non-retryable B2 errors as generic request failures', () => {
    const message = formatActionError(
      new B2Error({ status: 400, code: 'bad_request', message: 'bad request' }),
    )

    expect(message).toBe('B2 request failed: B2 said: bad request (status 400, code bad_request)')
  })

  it('redacts supplied secrets from reflected SDK error fields', () => {
    const applicationKey = 'app-key-secret'
    const authToken = 'issued-auth-token'
    const message = formatActionError(
      new AccessDeniedError(
        {
          status: 403,
          code: 'access_denied',
          message: `denied for ${applicationKey} with ${authToken}`,
        },
        { requestId: `request-${authToken}` },
      ),
      { secretValues: [applicationKey, authToken] },
    )

    expect(message).toContain('***')
    expect(message).not.toContain(applicationKey)
    expect(message).not.toContain(authToken)
  })

  it('bounds reflected SDK error message length', () => {
    const message = formatActionError(new NetworkError('x'.repeat(1_500)), { action: 'list' })

    expect(message).toContain('... [truncated]')
    expect(message.length).toBeLessThan(1_100)
  })
})
