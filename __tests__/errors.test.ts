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
import { classifyActionError } from '../src/errors.ts'

describe('classifyActionError', () => {
  it('classifies B2 authentication failures with credential guidance', () => {
    const error = new BadAuthTokenError(
      { status: 401, code: 'bad_auth_token', message: 'bad auth token' },
      { requestId: 'auth-request' },
    )

    expect(message(error)).toBe(
      'B2 authentication failed: check application-key-id and application-key, and confirm the key is active. B2 response details: status 401, code bad_auth_token',
    )
  })

  it('classifies server-side unauthorized scope failures as permission failures', () => {
    const error = new BadAuthTokenError({
      status: 401,
      code: 'unauthorized',
      message: 'Application key is missing capabilities: listFiles',
    })

    const result = message(error)

    expect(result).toBe(
      'B2 permission denied: application key is missing required capabilities or is outside the bucket/prefix scope. Update the key capabilities or use a key scoped to this bucket/prefix. B2 response details: status 401, code unauthorized',
    )
    expect(result).not.toContain('B2 authentication failed')
  })

  it('classifies missing capabilities as permission failures', () => {
    const error = new B2InsufficientCapabilityError(
      ['listFiles', 'writeFiles'],
      ['listFiles'],
      ['writeFiles'],
    )

    expect(message(error)).toBe(
      'B2 permission denied: application key is missing required capabilities: writeFiles. Update the key capabilities or use a key scoped to this bucket/prefix.',
    )
  })

  it('classifies B2 access denied errors as permission failures', () => {
    const error = new AccessDeniedError(
      { status: 403, code: 'access_denied', message: 'prefix is not allowed' },
      { requestId: 'access-request' },
    )

    expect(message(error)).toBe(
      'B2 permission denied: check application key capabilities, bucket access, and file name prefix restrictions. B2 response details: status 403, code access_denied',
    )
  })

  it('uses read-only retry guidance only for read-side actions', () => {
    const result = classifyActionError(new NetworkError('fetch failed'), { action: 'list' })

    expect(result).toEqual({
      message: 'Transient network error talking to B2: safe to retry this workflow. fetch failed',
      retryable: true,
      retryAfter: 30,
    })
  })

  it('uses read-only retry guidance for dry-run actions', () => {
    const result = classifyActionError(new NetworkError('fetch failed'), {
      action: 'delete',
      dryRun: true,
    })

    expect(result).toEqual({
      message:
        'Transient network error talking to B2: safe to retry this dry-run workflow. fetch failed',
      retryable: true,
      retryAfter: 30,
    })
  })

  it('uses conservative retry guidance and retryable=false for mutating actions', () => {
    const result = classifyActionError(new NetworkError('fetch failed'), { action: 'upload' })

    expect(result).toEqual({
      message:
        'Transient network error talking to B2: the upload action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes. fetch failed',
      retryable: false,
      retryAfter: undefined,
    })
  })

  it('redacts URL and bearer token patterns from network error messages', () => {
    const result = message(
      new NetworkError(
        'fetch https://signed.example/file?sig=abc Bearer abcdef1234567890abcdef1234567890',
      ),
      { action: 'list' },
    )

    expect(result).toBe(
      'Transient network error talking to B2: safe to retry this workflow. fetch [redacted-url] Bearer ***',
    )
    expect(result).not.toContain('https://signed.example')
    expect(result).not.toContain('abcdef1234567890abcdef1234567890')
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
        'Transient B2 error: safe to retry this workflow. B2 response details: status 503, code service_unavailable, retry after 30s',
      retryable: true,
      retryAfter: 30,
    })
  })

  it('does not expose retryable=true or retry-after for mutating retryable B2 failures', () => {
    const result = classifyActionError(
      new ServiceUnavailableError(
        { status: 503, code: 'service_unavailable', message: 'try again later' },
        { retryAfter: 30, requestId: 'retry-request' },
      ),
      { action: 'upload' },
    )

    expect(result).toEqual({
      message:
        'Transient B2 error: the upload action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes. B2 response details: status 503, code service_unavailable, retry after 30s',
      retryable: false,
      retryAfter: undefined,
    })
  })

  it('clamps retry-after values before exposing them', () => {
    const result = classifyActionError(
      new ServiceUnavailableError(
        { status: 503, code: 'service_unavailable', message: 'try again later' },
        { retryAfter: 99_999 },
      ),
      { action: 'download' },
    )

    expect(result.retryAfter).toBe(3_600)
    expect(result.message).toContain('retry after 3600s')
  })

  it('keeps expired auth token errors in the transient category', () => {
    const result = message(
      new ExpiredAuthTokenError({
        status: 401,
        code: 'expired_auth_token',
        message: 'expired token',
      }),
      { action: 'head' },
    )

    expect(result).toBe(
      'Transient B2 error: safe to retry this workflow. B2 response details: status 401, code expired_auth_token',
    )
  })

  it('classifies endpoint safety failures without echoing raw URLs', () => {
    const rawUrl = 'http://user:password@169.254.169.254/latest/meta-data?token=secret'
    const result = message(new B2SsrfError(`malformed URL from B2 response: ${rawUrl}`, rawUrl))

    expect(result).toBe(
      'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.',
    )
    expect(result).not.toContain(rawUrl)
    expect(result).not.toContain('password')
    expect(result).not.toContain('token=secret')
  })

  it('classifies wrapped endpoint safety failures before network retry handling', () => {
    const rawUrl = 'http://169.254.169.254/latest/meta-data'
    const result = classifyActionError(
      new NetworkError('fetch failed', new B2SsrfError(`blocked ${rawUrl}`, rawUrl)),
      { action: 'list' },
    )

    expect(result).toEqual({
      message:
        'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.',
      retryable: false,
      retryAfter: undefined,
    })
  })

  it('classifies non-retryable B2 errors as generic request failures', () => {
    const result = classifyActionError(
      new B2Error({ status: 400, code: 'bad_request', message: 'bad request' }, { retryAfter: 60 }),
    )

    expect(result).toEqual({
      message:
        'B2 request failed: B2 response details: status 400, code bad_request, retry after 60s',
      retryable: false,
      retryAfter: undefined,
    })
  })

  it('does not reflect signed URLs or bearer tokens from server error messages', () => {
    const signedUrl = 'https://files.example/bucket/file.txt?X-Bz-Signature=abcdef123456'
    const bearer = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    const result = message(
      new AccessDeniedError({
        status: 403,
        code: 'access_denied',
        message: `denied for ${signedUrl} ${bearer}`,
      }),
    )

    expect(result).toBe(
      'B2 permission denied: check application key capabilities, bucket access, and file name prefix restrictions. B2 response details: status 403, code access_denied',
    )
    expect(result).not.toContain(signedUrl)
    expect(result).not.toContain(bearer)
  })

  it('does not reflect request IDs containing transformed credentials', () => {
    const applicationKey = 'app-key-secret'
    const encoded = Buffer.from(`key-id:${applicationKey}`).toString('base64')
    const result = message(
      new AccessDeniedError(
        {
          status: 403,
          code: 'access_denied',
          message: 'denied',
        },
        { requestId: encoded },
      ),
      { secretValues: [applicationKey] },
    )

    expect(result).not.toContain(encoded)
    expect(result).not.toContain(applicationKey)
  })

  it('bounds reflected SDK error message length', () => {
    const result = message(new NetworkError('x '.repeat(800)), { action: 'list' })

    expect(result).toContain('... [truncated]')
    expect(result.length).toBeLessThan(1_100)
  })
})

function message(err: unknown, options?: Parameters<typeof classifyActionError>[1]): string {
  return classifyActionError(err, options).message
}
