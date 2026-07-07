import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanupUnfinishedCommand } from '../../src/commands/cleanup-unfinished.ts'
import type { ParsedInputs } from '../../src/inputs.ts'
import { captureStdout, makeFixture, makeInputs, type TestFixture } from '../_helpers.ts'

describe('cleanup-unfinished command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-cleanup-unfinished')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('cancels unfinished large uploads under the source prefix', async () => {
    const matched = await startUnfinishedLargeFile(
      fx,
      'tmp/abandoned.bin',
      [bytes('part-one'), bytes('part-two')],
      {
        password: 'should-not-leak',
        secret: 'should-not-leak',
        'private-key': 'should-not-leak',
        'application-key': 'should-not-leak',
      },
    )
    await startUnfinishedLargeFile(fx, 'other/keep.bin', [bytes('keep')])

    const result = await cleanupUnfinishedCommand(
      fx.bucket,
      baseInputs({
        source: 'tmp/',
        cleanupUnfinishedForce: true,
      }),
    )

    expect(result).toEqual({
      files: [
        {
          fileName: 'tmp/abandoned.bin',
          fileId: matched.fileId,
          partCount: 2,
          size: 16,
          status: 'canceled',
        },
      ],
      errors: 0,
    })
    await expectUnfinishedNames(fx.bucket, ['other/keep.bin'])
  })

  it('previews matched unfinished uploads during dry-run', async () => {
    const first = await startUnfinishedLargeFile(fx, 'one.bin', [bytes('one')])
    const second = await startUnfinishedLargeFile(fx, 'two.bin', [bytes('two')])

    const result = await cleanupUnfinishedCommand(
      fx.bucket,
      baseInputs({
        source: undefined,
        dryRun: true,
        cleanupUnfinishedForce: true,
      }),
    )

    expect(result).toEqual({
      files: [
        {
          fileName: 'one.bin',
          fileId: first.fileId,
          partCount: 1,
          size: 3,
          status: 'would-cancel',
        },
        {
          fileName: 'two.bin',
          fileId: second.fileId,
          partCount: 1,
          size: 3,
          status: 'would-cancel',
        },
      ],
      errors: 0,
    })
    await expectUnfinishedNames(fx.bucket, ['one.bin', 'two.bin'])
  })

  it('rejects whole-bucket cleanup without an explicit opt-in', async () => {
    await expect(cleanupUnfinishedCommand(fx.bucket, baseInputs())).rejects.toThrow(
      /'allow-bucket-cleanup' must be true/,
    )
    await expect(cleanupUnfinishedCommand(fx.bucket, baseInputs({ source: '' }))).rejects.toThrow(
      /'allow-bucket-cleanup' must be true/,
    )
  })

  it('cleans the whole bucket when explicitly opted in', async () => {
    const upload = await startUnfinishedLargeFile(fx, 'bucket-wide.bin', [bytes('part')])

    const result = await cleanupUnfinishedCommand(
      fx.bucket,
      baseInputs({
        allowBucketCleanup: true,
        cleanupUnfinishedForce: true,
      }),
    )

    expect(result).toEqual({
      files: [
        {
          fileName: 'bucket-wide.bin',
          fileId: upload.fileId,
          partCount: 1,
          size: 4,
          status: 'canceled',
        },
      ],
      errors: 0,
    })
    await expectUnfinishedNames(fx.bucket, [])
  })

  it('skips active uploads by default', async () => {
    const active = await startUnfinishedLargeFile(fx, 'tmp/active.bin', [bytes('fresh')])

    const result = await cleanupUnfinishedCommand(fx.bucket, baseInputs({ source: 'tmp/' }))

    expect(result).toEqual({
      files: [
        {
          fileName: 'tmp/active.bin',
          fileId: active.fileId,
          partCount: 1,
          size: 5,
          status: 'skipped-active',
          reason: 'recent-parts',
        },
      ],
      errors: 0,
    })
    await expectUnfinishedNames(fx.bucket, ['tmp/active.bin'])
  })

  it('treats part diagnostics as best-effort when force is set', async () => {
    const canceled: string[] = []
    const bucket = {
      name: 'mock-bucket',
      paginateUnfinishedLargeFiles: async function* () {
        yield {
          fileName: 'unknown.bin',
          fileId: 'large-unknown',
          contentType: 'application/octet-stream',
          fileInfo: {},
        }
        yield {
          fileName: 'known.bin',
          fileId: 'large-known',
          contentType: 'application/octet-stream',
          fileInfo: {},
        }
      },
      paginateParts: async function* (fileId: string) {
        if (fileId === 'large-unknown') throw new Error('list parts failed')
        yield {
          contentLength: 10,
          uploadTimestamp: Date.now() - 48 * 60 * 60 * 1000,
        }
      },
      cancelLargeFile: async (fileId: string) => {
        canceled.push(fileId)
      },
    } as unknown as Bucket

    const result = await cleanupUnfinishedCommand(
      bucket,
      baseInputs({
        source: 'tmp/',
        cleanupUnfinishedForce: true,
      }),
    )

    expect(canceled).toEqual(['large-unknown', 'large-known'])
    expect(result).toEqual({
      files: [
        {
          fileName: 'unknown.bin',
          fileId: 'large-unknown',
          partCount: null,
          size: null,
          status: 'canceled',
        },
        {
          fileName: 'known.bin',
          fileId: 'large-known',
          partCount: 1,
          size: 10,
          status: 'canceled',
        },
      ],
      errors: 0,
    })
  })

  it('skips diagnostically truncated uploads unless force is set', async () => {
    let canceled = false
    const bucket = {
      name: 'mock-bucket',
      paginateUnfinishedLargeFiles: async function* () {
        yield {
          fileName: 'huge.bin',
          fileId: 'large-huge',
          contentType: 'application/octet-stream',
          fileInfo: {},
        }
      },
      paginateParts: async function* () {
        for (let i = 0; i < 101; i++) {
          yield {
            contentLength: 1,
            uploadTimestamp: Date.now() - 48 * 60 * 60 * 1000,
          }
        }
      },
      cancelLargeFile: async () => {
        canceled = true
      },
    } as unknown as Bucket

    const result = await cleanupUnfinishedCommand(bucket, baseInputs({ source: 'tmp/' }))

    expect(canceled).toBe(false)
    expect(result).toEqual({
      files: [
        {
          fileName: 'huge.bin',
          fileId: 'large-huge',
          partCount: 100,
          size: 100,
          partsTruncated: true,
          status: 'skipped-unknown',
          reason: 'parts-truncated',
        },
      ],
      errors: 0,
    })
  })

  it('logs truncated forced cleanup counts as lower bounds', async () => {
    const bucket = {
      name: 'mock-bucket',
      paginateUnfinishedLargeFiles: async function* () {
        yield {
          fileName: 'huge.bin',
          fileId: 'large-huge',
          contentType: 'application/octet-stream',
          fileInfo: {},
        }
      },
      paginateParts: async function* () {
        for (let i = 0; i < 101; i++) {
          yield {
            contentLength: 1,
            uploadTimestamp: Date.now() - 48 * 60 * 60 * 1000,
          }
        }
      },
      cancelLargeFile: async () => {},
    } as unknown as Bucket

    const stdout = await captureStdout(async () => {
      await cleanupUnfinishedCommand(
        bucket,
        baseInputs({ source: 'tmp/', cleanupUnfinishedForce: true }),
      )
    })

    expect(stdout).toContain(
      'canceled huge.bin (large-huge; >=100 part(s), >=100 bytes (truncated))',
    )
  })

  it('counts cancel failures with structured diagnostics and no raw error text', async () => {
    const bucket = {
      name: 'mock-bucket',
      paginateUnfinishedLargeFiles: async function* () {
        yield {
          fileName: 'stuck.bin',
          fileId: 'large-id',
          contentType: 'application/octet-stream',
          fileInfo: {},
        }
      },
      paginateParts: async function* () {
        yield { contentLength: 10, uploadTimestamp: Date.now() - 48 * 60 * 60 * 1000 }
      },
      cancelLargeFile: async () => {
        throw {
          status: 503,
          code: 'service_unavailable secret-token',
          retryable: true,
          retryAfter: 12,
          message: 'cancel denied with secret-token',
        }
      },
    } as unknown as Bucket

    let result: Awaited<ReturnType<typeof cleanupUnfinishedCommand>> | undefined
    const stdout = await captureStdout(async () => {
      result = await cleanupUnfinishedCommand(bucket, baseInputs({ source: 'tmp/' }))
    })

    expect(result).toEqual({
      files: [
        {
          fileName: 'stuck.bin',
          fileId: 'large-id',
          partCount: 1,
          size: 10,
          status: 'failed',
          error: {
            message: 'cancel failed',
            status: 503,
            code: 'unknown',
            retryable: true,
            retryAfter: 12,
          },
        },
      ],
      errors: 1,
    })
    expect(stdout).toContain(
      'failed to cancel stuck.bin (large-id): cancel failed (status 503, code unknown, retryable true, retry after 12s)',
    )
    expect(stdout).not.toContain('cancel denied')
    expect(stdout).not.toContain('secret-token')
  })

  it('preserves safe B2 auth token error codes in cancel diagnostics', async () => {
    for (const code of ['bad_auth_token', 'expired_auth_token']) {
      const bucket = {
        name: 'mock-bucket',
        paginateUnfinishedLargeFiles: async function* () {
          yield {
            fileName: `${code}.bin`,
            fileId: `large-${code}`,
            contentType: 'application/octet-stream',
            fileInfo: {},
          }
        },
        paginateParts: async function* () {
          yield { contentLength: 10, uploadTimestamp: Date.now() - 48 * 60 * 60 * 1000 }
        },
        cancelLargeFile: async () => {
          throw {
            status: 401,
            code,
            message: 'auth failed',
          }
        },
      } as unknown as Bucket

      const result = await cleanupUnfinishedCommand(bucket, baseInputs({ source: 'tmp/' }))

      expect(result.files[0]?.status).toBe('failed')
      expect(result.files[0]?.error).toMatchObject({
        status: 401,
        code,
      })
    }
  })
})

async function startUnfinishedLargeFile(
  fx: TestFixture,
  fileName: string,
  parts: Uint8Array[],
  fileInfo: Record<string, string> = { purpose: 'test' },
) {
  const { apiUrl, authToken } = auth(fx)
  const started = await fx.client.raw.startLargeFile(apiUrl, authToken, {
    bucketId: fx.bucket.id,
    fileName,
    contentType: 'application/octet-stream',
    fileInfo,
  })

  for (const [index, body] of parts.entries()) {
    const upload = await fx.client.raw.getUploadPartUrl(apiUrl, authToken, {
      fileId: started.fileId,
    })
    await fx.client.raw.uploadPart(
      upload.uploadUrl,
      {
        authorization: upload.authorizationToken,
        partNumber: index + 1,
        contentLength: body.byteLength,
        contentSha1: sha1Hex(body),
      },
      arrayBuffer(body),
    )
  }

  return started
}

async function expectUnfinishedNames(bucket: Bucket, names: string[]): Promise<void> {
  const actual: string[] = []
  for await (const unfinished of bucket.paginateUnfinishedLargeFiles()) {
    actual.push(unfinished.fileName)
  }
  expect(actual).toEqual(names)
}

function auth(fx: TestFixture): { apiUrl: string; authToken: string } {
  return {
    apiUrl: fx.client.accountInfo.getApiUrl(),
    authToken: fx.client.accountInfo.getAuthToken(),
  }
}

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

function sha1Hex(value: Uint8Array): string {
  return createHash('sha1').update(value).digest('hex')
}

function baseInputs(override: Partial<ParsedInputs> = {}): ParsedInputs {
  return makeInputs('cleanup-unfinished', {
    bucket: 'gh-action-cleanup-unfinished',
    ...override,
  })
}
