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
import { describe, expect, it, vi } from 'vitest'
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

  it('does not treat unsupported dry-run inputs as automatically retryable', () => {
    const result = classifyActionError(new NetworkError('fetch failed'), {
      action: 'upload',
      dryRun: true,
    })

    expect(result).toEqual({
      message:
        'Transient network error talking to B2: the upload action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes. fetch failed',
      retryable: false,
      retryAfter: undefined,
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
      new B2Error(
        { status: 400, code: 'bad_request', message: 'bad request: file name is required' },
        { retryAfter: 60 },
      ),
    )

    expect(result).toEqual({
      message:
        'B2 request failed: Bad request; check the action inputs for invalid values. B2 said: bad request: file name is required. B2 response details: status 400, code bad_request, retry after 60s',
      retryable: false,
      retryAfter: undefined,
    })
  })

  it.each([
    [
      { status: 404, code: 'file_not_present', message: 'file docs/missing.txt not present' },
      'File not found',
      'docs/missing.txt',
    ],
    [
      { status: 400, code: 'duplicate_bucket_name', message: 'bucket already exists: docs-prod' },
      'Bucket name already exists',
      'docs-prod',
    ],
    [
      { status: 403, code: 'cap_exceeded', message: 'storage cap exceeded for account' },
      'B2 account cap was exceeded',
      'storage cap exceeded',
    ],
    [
      { status: 400, code: 'bad_request', message: 'invalid retention mode: forever' },
      'Bad request',
      'invalid retention mode',
    ],
  ] as const)('includes actionable detail for generic B2 code %s', (response, prefix, detail) => {
    const result = message(new B2Error(response))

    expect(result).toContain(prefix)
    expect(result).toContain(detail)
    expect(result).toContain(`status ${response.status}`)
    expect(result).toContain(`code ${response.code}`)
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

  it('redacts transformed secret values from reflected error messages', () => {
    const applicationKey = 'app/key+secret=42'
    const base64 = Buffer.from(applicationKey).toString('base64')
    const base64Url = base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
    const hex = Buffer.from(applicationKey).toString('hex')
    const urlEncoded = encodeURIComponent(applicationKey)
    const result = message(
      new NetworkError(`leaked ${applicationKey} ${base64} ${base64Url} ${hex} ${urlEncoded}`),
      { action: 'list', secretValues: [applicationKey] },
    )

    expect(result).not.toContain(applicationKey)
    expect(result).not.toContain(base64)
    expect(result).not.toContain(base64Url)
    expect(result).not.toContain(hex)
    expect(result).not.toContain(urlEncoded)
  })

  it('does not throw when secret URI encoding would fail', () => {
    const malformed = 'app-key-\uD800-secret'
    const result = message(new NetworkError(`leaked ${malformed}`), {
      action: 'list',
      secretValues: [malformed],
    })

    expect(result).toContain('***')
    expect(result).not.toContain(malformed)
  })

  it('does not derive encoded variants for oversized secrets', () => {
    const oversized = 'secret'.repeat(400)
    const bufferFrom = vi.spyOn(Buffer, 'from')
    try {
      const result = message(new NetworkError(oversized), {
        action: 'list',
        secretValues: [oversized],
      })

      expect(result).toContain('***')
      expect(result).not.toContain(oversized.slice(0, 100))
      expect(bufferFrom).not.toHaveBeenCalled()
    } finally {
      bufferFrom.mockRestore()
    }
  })

  it('redacts secrets that cross the input truncation boundary', () => {
    const secret = 'zxq-boundary-secret-value'
    const signedUrl = `https://files.example/${'a'.repeat(1_800)}`
    const filler = 'x'.repeat(1_995 - signedUrl.length - 1)
    const leakedPrefix = secret.slice(0, 5)
    const result = message(new NetworkError(`${signedUrl} ${filler}${secret} trailing`), {
      action: 'list',
      secretValues: [secret],
    })

    expect(result).toContain('***')
    expect(result).not.toContain(secret)
    expect(result).not.toContain(leakedPrefix)
  })

  it('does not redact non-secret B2 file IDs or SHA-1 hashes', () => {
    const fileId =
      '4_z0000000000000000000000001_f200ec353a2187_d20250101_m000001_c001_v0001000_t0001'
    const sha1 = '0123456789abcdef0123456789abcdef01234567'
    const result = message(new NetworkError(`file ${fileId} sha1 ${sha1} failed`), {
      action: 'list',
    })

    expect(result).toContain(fileId)
    expect(result).toContain(sha1)
  })

  it('terminates on cyclic error causes', () => {
    const error = new Error('cyclic failure') as Error & { cause?: unknown }
    error.cause = error

    expect(classifyActionError(error)).toEqual({
      message: 'cyclic failure',
      retryable: undefined,
      retryAfter: undefined,
    })
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
