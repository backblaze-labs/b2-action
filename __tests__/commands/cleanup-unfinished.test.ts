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
    const matched = await startUnfinishedLargeFile(fx, 'tmp/abandoned.bin', [
      bytes('part-one'),
      bytes('part-two'),
    ])
    await startUnfinishedLargeFile(fx, 'other/keep.bin', [bytes('keep')])

    const result = await cleanupUnfinishedCommand(fx.bucket, baseInputs({ source: 'tmp/' }))

    expect(result).toEqual({
      files: [
        {
          fileName: 'tmp/abandoned.bin',
          fileId: matched.fileId,
          contentType: 'application/octet-stream',
          fileInfo: { purpose: 'test' },
          partCount: 2,
          size: 16,
          skipped: false,
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
      }),
    )

    expect(result).toEqual({
      files: [
        {
          fileName: 'one.bin',
          fileId: first.fileId,
          contentType: 'application/octet-stream',
          fileInfo: { purpose: 'test' },
          partCount: 1,
          size: 3,
          skipped: true,
        },
        {
          fileName: 'two.bin',
          fileId: second.fileId,
          contentType: 'application/octet-stream',
          fileInfo: { purpose: 'test' },
          partCount: 1,
          size: 3,
          skipped: true,
        },
      ],
      errors: 0,
    })
    await expectUnfinishedNames(fx.bucket, ['one.bin', 'two.bin'])
  })

  it('counts cancel failures without logging raw error text', async () => {
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
        yield { contentLength: 10 }
      },
      cancelLargeFile: async () => {
        throw new Error('cancel denied with secret-token')
      },
    } as unknown as Bucket

    let result: Awaited<ReturnType<typeof cleanupUnfinishedCommand>> | undefined
    const stdout = await captureStdout(async () => {
      result = await cleanupUnfinishedCommand(bucket, baseInputs())
    })

    expect(result).toEqual({
      files: [],
      errors: 1,
    })
    expect(stdout).toContain('failed to cancel stuck.bin (large-id): cancel failed')
    expect(stdout).not.toContain('secret-token')
  })
})

async function startUnfinishedLargeFile(fx: TestFixture, fileName: string, parts: Uint8Array[]) {
  const { apiUrl, authToken } = auth(fx)
  const started = await fx.client.raw.startLargeFile(apiUrl, authToken, {
    bucketId: fx.bucket.id,
    fileName,
    contentType: 'application/octet-stream',
    fileInfo: { purpose: 'test' },
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
