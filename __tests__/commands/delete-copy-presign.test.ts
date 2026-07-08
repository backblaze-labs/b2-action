import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Bucket as B2Bucket, type B2Client, type Bucket } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyCommand } from '../../src/commands/copy.ts'
import { deleteCommand } from '../../src/commands/delete.ts'
import { presignCommand } from '../../src/commands/presign.ts'
import { uploadCommand } from '../../src/commands/upload.ts'
import type { ParsedInputs } from '../../src/inputs.ts'
import { parseSse } from '../../src/sse.ts'
import {
  captureFailure,
  captureStdout,
  makeFixture,
  makeInputs,
  seedFile,
  seedGovernanceRetainedFile,
  type TestFixture,
} from '../_helpers.ts'

function baseInputs(action: ParsedInputs['action']): ParsedInputs {
  return makeInputs(action, { bucket: 'gh-action-misc' })
}

describe('delete command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('deletes a single file by name', async () => {
    const local = join(fx.workDir, 'gone.txt')
    await writeFile(local, 'bye')
    await uploadCommand(fx.bucket, { ...baseInputs('upload'), source: local })

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'gone.txt',
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.fileName).toBe('gone.txt')
    expect(result.files[0]?.skipped).toBe(false)
  })

  it('dry-run reports what would be deleted without deleting', async () => {
    const local = join(fx.workDir, 'staying.txt')
    await writeFile(local, 'hi')
    await uploadCommand(fx.bucket, { ...baseInputs('upload'), source: local })

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'staying.txt',
      dryRun: true,
    })

    expect(result.files[0]?.skipped).toBe(true)

    const page = await fx.bucket.listFileNames({ prefix: 'staying.txt' })
    expect(page.files.some((f) => f.fileName === 'staying.txt' && f.action === 'upload')).toBe(true)
  })

  it('deletes all versions under a prefix', async () => {
    for (const name of ['p/a.txt', 'p/b.txt', 'q/c.txt']) {
      const local = join(fx.workDir, name.replace('/', '_'))
      await writeFile(local, name)
      await uploadCommand(fx.bucket, {
        ...baseInputs('upload'),
        source: local,
        destination: name,
      })
    }

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'p/',
    })

    expect(result.files.length).toBeGreaterThanOrEqual(2)
    expect(result.errors).toBe(0)
    const remaining = await fx.bucket.listFileNames({ prefix: '' })
    expect(remaining.files.some((f) => f.fileName === 'q/c.txt')).toBe(true)
    expect(remaining.files.some((f) => f.fileName.startsWith('p/'))).toBe(false)
  })

  it('requires bypass-governance to delete a governance-retained file by name', async () => {
    await seedGovernanceRetainedFile(fx, 'locked-one.txt')

    await expect(
      deleteCommand(fx.bucket, {
        ...baseInputs('delete'),
        source: 'locked-one.txt',
      }),
    ).rejects.toThrow(/governance-mode retention/)

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'locked-one.txt',
      bypassGovernance: true,
    })

    expect(result.errors).toBe(0)
    expect(result.files[0]?.skipped).toBe(false)

    const after = await fx.bucket.listFileVersions({ prefix: 'locked-one.txt' })
    expect(after.files).toHaveLength(0)
  })

  it('requires bypass-governance for governance-retained versions under a prefix', async () => {
    await seedGovernanceRetainedFile(fx, 'locked-prefix/a.txt')
    await seedGovernanceRetainedFile(fx, 'locked-prefix/b.txt')

    const blocked = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'locked-prefix/',
    })

    expect(blocked.errors).toBe(2)
    const afterBlocked = await fx.bucket.listFileVersions({ prefix: 'locked-prefix/' })
    expect(afterBlocked.files).toHaveLength(2)

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'locked-prefix/',
      bypassGovernance: true,
    })

    expect(result.errors).toBe(0)
    expect(result.files).toHaveLength(2)

    const afterBypass = await fx.bucket.listFileVersions({ prefix: 'locked-prefix/' })
    expect(afterBypass.files).toHaveLength(0)
  })

  it('dry-run does not consume bypass-governance for prefix delete previews', async () => {
    await seedGovernanceRetainedFile(fx, 'locked-preview/a.txt')
    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'locked-preview/',
      dryRun: true,
      bypassGovernance: true,
    })

    expect(result.errors).toBe(0)
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.skipped).toBe(true)

    const after = await fx.bucket.listFileVersions({ prefix: 'locked-preview/' })
    expect(after.files).toHaveLength(1)
  })

  it('stops prefix deletes when the signal is already aborted', async () => {
    await seedFile(fx, 'abort/a.txt', 'a')
    const controller = new AbortController()
    controller.abort(new Error('delete cancelled'))

    await expect(
      deleteCommand(
        fx.bucket,
        {
          ...baseInputs('delete'),
          source: 'abort/',
        },
        controller.signal,
      ),
    ).rejects.toThrow('delete cancelled')

    const after = await fx.bucket.listFileVersions({ prefix: 'abort/' })
    expect(after.files).toHaveLength(1)
  })

  it('does not log raw per-version delete error text', async () => {
    const encodedSecret = encodeURIComponent('app/key+secret=42')
    const bucket = {
      name: 'gh-action-misc',
      paginateFileVersions: async function* () {
        yield { fileName: 'p/a.txt', fileId: 'id-a', action: 'upload' }
      },
      deleteFileVersion: async () => {
        throw new Error(`delete denied with ${encodedSecret}`)
      },
    } as unknown as Parameters<typeof deleteCommand>[0]
    let result: Awaited<ReturnType<typeof deleteCommand>> | undefined

    const out = await captureStdout(async () => {
      result = await deleteCommand(bucket, {
        ...baseInputs('delete'),
        source: 'p/',
      })
    })

    expect(result?.errors).toBe(1)
    expect(out).toContain('failed to delete p/a.txt: delete failed')
    expect(out).not.toContain(encodedSecret)
    expect(out).not.toContain('app/key+secret=42')
  })

  it('throws when the file is not found', async () => {
    await expect(
      deleteCommand(fx.bucket, { ...baseInputs('delete'), source: 'nope.txt' }),
    ).rejects.toThrow(/not found/)
  })

  it('does not disclose hidden source existence in default dry-run logs', async () => {
    await seedFile(fx, 'private-delete.txt', 'secret')
    await fx.bucket.hideFile('private-delete.txt')

    const { error, stdout } = await captureFailure(() =>
      deleteCommand(fx.bucket, {
        ...baseInputs('delete'),
        source: 'private-delete.txt',
        dryRun: true,
      }),
    )

    expect(error.message).toBe(`File not found in bucket "${fx.bucket.name}": private-delete.txt`)
    expect(`${stdout}\n${error.message}`).not.toMatch(/File is hidden|hide marker|latest version/)
  })
})

describe('copy command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('server-side copies a small file', async () => {
    const local = join(fx.workDir, 'src.txt')
    await writeFile(local, 'copy me')
    await uploadCommand(fx.bucket, {
      ...baseInputs('upload'),
      source: local,
      destination: 'src.txt',
    })

    const result = await copyCommand(fx.client, fx.bucket, {
      ...baseInputs('copy'),
      source: 'src.txt',
      destination: 'archive/src.txt',
    })

    expect(result.destinationFileName).toBe('archive/src.txt')
    expect(result.fileId).toBeTruthy()
    expect(result.size).toBe(7)

    const remaining = await fx.bucket.listFileNames({ prefix: '' })
    expect(remaining.files.some((f) => f.fileName === 'src.txt')).toBe(true)
    expect(remaining.files.some((f) => f.fileName === 'archive/src.txt')).toBe(true)
  })

  it('passes source and destination SSE settings to small copy', async () => {
    const sourceKey = Buffer.alloc(32, 0x64).toString('base64')
    const sourceEncryption = parseSse(`C:${sourceKey}`)
    const destinationEncryption = parseSse('B2')
    const copyFile = vi.fn(async () => ({ fileId: 'copy-id', contentLength: 5 }))
    const copyLargeFile = vi.fn()
    const bucket = {
      name: 'dest-bucket',
      id: 'dest-bucket-id',
      listFileNames: vi.fn(async () => ({
        files: [
          {
            action: 'upload',
            fileId: 'source-file-id',
            fileName: 'src.txt',
            contentLength: 5,
          },
        ],
      })),
      copyFile,
      copyLargeFile,
    } as unknown as Bucket
    const client = {
      accountInfo: { getRecommendedPartSize: () => 100 },
    } as unknown as B2Client

    const out = await captureStdout(async () => {
      await copyCommand(client, bucket, {
        ...baseInputs('copy'),
        source: 'src.txt',
        destination: 'dst.txt',
        encryption: destinationEncryption,
        sourceEncryption,
      })
    })

    expect(copyFile).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFileId: 'source-file-id',
        fileName: 'dst.txt',
        sourceServerSideEncryption: sourceEncryption,
        destinationServerSideEncryption: destinationEncryption,
      }),
    )
    expect(copyLargeFile).not.toHaveBeenCalled()
    expect(out).not.toContain(sourceKey)
  })

  it('sends source and destination SSE-C on large copy parts', async () => {
    const sourceKey = Buffer.alloc(32, 0x65).toString('base64')
    const destinationKey = Buffer.alloc(32, 0x66).toString('base64')
    const sourceEncryption = parseSse(`C:${sourceKey}`)
    const destinationEncryption = parseSse(`C:${destinationKey}`)
    const copyPartRequests: Array<Record<string, unknown>> = []
    let startRequest: Record<string, unknown> | undefined
    let finishRequest: Record<string, unknown> | undefined
    const copyFile = vi.fn()
    const listFileNames = vi.fn(async () => ({
      files: [
        {
          action: 'upload',
          fileId: 'large-source-file-id',
          fileName: 'large.bin',
          contentLength: 250,
          contentType: 'application/octet-stream',
          fileInfo: {
            purpose: 'copy-test',
          },
        },
      ],
    }))
    const getFileInfo = vi.fn(async () => ({
      fileId: 'large-source-file-id',
      bucketId: 'source-bucket-id',
      fileName: 'large.bin',
      contentLength: 250,
      contentType: 'application/octet-stream',
      fileInfo: {
        purpose: 'copy-test',
      },
    }))
    const startLargeFile = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        startRequest = request
        return {
          fileId: 'large-file-id',
          fileName: request.fileName,
          accountId: 'account-id',
          bucketId: request.bucketId,
          contentType: request.contentType,
          fileInfo: {},
        }
      },
    )
    const copyPart = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        copyPartRequests.push(request)
        return {
          fileId: request.largeFileId,
          partNumber: request.partNumber,
          contentLength: 100,
          contentSha1: `sha-${request.partNumber}`,
        }
      },
    )
    const finishLargeFile = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        finishRequest = request
        return {
          fileId: 'finished-large-file-id',
          contentLength: 250,
        }
      },
    )
    const cancelLargeFile = vi.fn()
    const client = {
      accountInfo: {
        getRecommendedPartSize: () => 100,
        getAbsoluteMinimumPartSize: () => 100,
        getApiUrl: () => 'https://api.example.test',
        getAuthToken: () => 'auth-token',
      },
      raw: {
        listFileNames,
        getFileInfo,
        copyFile,
        startLargeFile,
        copyPart,
        finishLargeFile,
        cancelLargeFile,
      },
    } as unknown as B2Client
    const bucket = new B2Bucket(
      client,
      {
        accountId: 'account-id',
        bucketId: 'dest-bucket-id',
        bucketName: 'dest-bucket',
        bucketType: 'allPrivate',
        bucketInfo: {},
        corsRules: [],
        defaultServerSideEncryption: { mode: 'none' },
        fileLockConfiguration: { isClientAuthorizedToRead: true, value: null },
        lifecycleRules: [],
        options: [],
        revision: 1,
        defaultRetention: { mode: 'none', period: null },
        replicationConfiguration: {
          asReplicationSource: null,
          asReplicationDestination: null,
        },
      } as unknown as ConstructorParameters<typeof B2Bucket>[1],
      { maxRetries: 0, maxRetryDelayMs: 0, initialRetryDelayMs: 0 },
    )
    const controller = new AbortController()

    const out = await captureStdout(async () => {
      await copyCommand(
        client,
        bucket,
        {
          ...baseInputs('copy'),
          source: 'large.bin',
          destination: 'large-copy.bin',
          encryption: destinationEncryption,
          sourceEncryption,
          concurrency: 1,
        },
        controller.signal,
      )
    })

    expect(copyFile).not.toHaveBeenCalled()
    expect(startRequest).toEqual(
      expect.objectContaining({
        bucketId: 'dest-bucket-id',
        fileName: 'large-copy.bin',
        fileInfo: {},
        serverSideEncryption: destinationEncryption,
      }),
    )
    expect(copyPartRequests).toEqual([
      expect.objectContaining({
        partNumber: 1,
        range: 'bytes=0-99',
        sourceServerSideEncryption: sourceEncryption,
        destinationServerSideEncryption: destinationEncryption,
      }),
      expect.objectContaining({
        partNumber: 2,
        range: 'bytes=100-199',
        sourceServerSideEncryption: sourceEncryption,
        destinationServerSideEncryption: destinationEncryption,
      }),
      expect.objectContaining({
        partNumber: 3,
        range: 'bytes=200-249',
        sourceServerSideEncryption: sourceEncryption,
        destinationServerSideEncryption: destinationEncryption,
      }),
    ])
    expect(finishRequest).toEqual(
      expect.objectContaining({
        fileId: 'large-file-id',
        partSha1Array: ['sha-1', 'sha-2', 'sha-3'],
      }),
    )
    expect(cancelLargeFile).not.toHaveBeenCalled()
    expect(out).not.toContain(sourceKey)
    expect(out).not.toContain(destinationKey)
  })

  it('starts SSE-B2 large copy without destination encryption on parts', async () => {
    const destinationEncryption = parseSse('B2')
    const copyFile = vi.fn()
    const copyLargeFile = vi.fn()
    const copyPartRequests: Array<Record<string, unknown>> = []
    let startRequest: Record<string, unknown> | undefined
    let finishRequest: Record<string, unknown> | undefined
    const startLargeFile = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        startRequest = request
        return {
          fileId: 'large-file-id',
          fileName: request.fileName,
          accountId: 'account-id',
          bucketId: request.bucketId,
          contentType: request.contentType,
          fileInfo: {},
        }
      },
    )
    const copyPart = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        copyPartRequests.push(request)
        return {
          fileId: request.largeFileId,
          partNumber: request.partNumber,
          contentLength: 100,
          contentSha1: `sha-${request.partNumber}`,
        }
      },
    )
    const finishLargeFile = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        finishRequest = request
        return {
          fileId: 'finished-large-file-id',
          contentLength: 250,
        }
      },
    )
    const cancelLargeFile = vi.fn()
    const bucket = {
      name: 'dest-bucket',
      id: 'dest-bucket-id',
      listFileNames: vi.fn(async () => ({
        files: [
          {
            action: 'upload',
            fileId: 'large-source-file-id',
            fileName: 'large-b2.bin',
            contentLength: 250,
            contentType: 'application/octet-stream',
            fileInfo: {
              src_last_modified_millis: '1720000000000',
              purpose: 'copy-test',
            },
          },
        ],
      })),
      copyFile,
      copyLargeFile,
    } as unknown as Bucket
    const client = {
      accountInfo: {
        getRecommendedPartSize: () => 100,
        getAbsoluteMinimumPartSize: () => 100,
        getApiUrl: () => 'https://api.example.test',
        getAuthToken: () => 'auth-token',
      },
      raw: {
        startLargeFile,
        copyPart,
        finishLargeFile,
        cancelLargeFile,
      },
    } as unknown as B2Client

    const result = await copyCommand(client, bucket, {
      ...baseInputs('copy'),
      source: 'large-b2.bin',
      destination: 'large-b2-copy.bin',
      encryption: destinationEncryption,
      concurrency: 2,
    })

    expect(result.fileId).toBe('finished-large-file-id')
    expect(copyLargeFile).not.toHaveBeenCalled()
    expect(copyFile).not.toHaveBeenCalled()
    expect(startRequest).toEqual(
      expect.objectContaining({
        bucketId: 'dest-bucket-id',
        fileName: 'large-b2-copy.bin',
        fileInfo: {
          src_last_modified_millis: '1720000000000',
          purpose: 'copy-test',
        },
        serverSideEncryption: destinationEncryption,
      }),
    )
    expect(copyPartRequests).toEqual([
      expect.objectContaining({ partNumber: 1, range: 'bytes=0-99' }),
      expect.objectContaining({ partNumber: 2, range: 'bytes=100-199' }),
      expect.objectContaining({ partNumber: 3, range: 'bytes=200-249' }),
    ])
    expect(
      copyPartRequests.every((request) => !('destinationServerSideEncryption' in request)),
    ).toBe(true)
    expect(finishRequest).toEqual(
      expect.objectContaining({
        fileId: 'large-file-id',
        partSha1Array: ['sha-1', 'sha-2', 'sha-3'],
      }),
    )
    expect(cancelLargeFile).not.toHaveBeenCalled()
  })

  it('cancels SSE-B2 large copy when a part fails', async () => {
    const destinationEncryption = parseSse('B2')
    const copyFile = vi.fn()
    const copyLargeFile = vi.fn()
    let releaseFirstPart: (() => void) | undefined
    const startLargeFile = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => ({
        fileId: 'large-file-id',
        fileName: request.fileName,
        accountId: 'account-id',
        bucketId: request.bucketId,
        contentType: request.contentType,
        fileInfo: {},
      }),
    )
    const copyPart = vi.fn(
      async (_apiUrl: string, _authToken: string, request: Record<string, unknown>) => {
        if (request.partNumber === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstPart = resolve
          })
        }
        if (request.partNumber === 2) throw new Error('part failed')
        return {
          fileId: request.largeFileId,
          partNumber: request.partNumber,
          contentLength: 100,
          contentSha1: `sha-${request.partNumber}`,
        }
      },
    )
    const finishLargeFile = vi.fn()
    const cancelLargeFile = vi.fn(async () => ({
      fileId: 'large-file-id',
      accountId: 'account-id',
      bucketId: 'dest-bucket-id',
      fileName: 'large-b2-copy.bin',
    }))
    const bucket = {
      name: 'dest-bucket',
      id: 'dest-bucket-id',
      listFileNames: vi.fn(async () => ({
        files: [
          {
            action: 'upload',
            fileId: 'large-source-file-id',
            fileName: 'large-b2.bin',
            contentLength: 250,
            contentType: 'application/octet-stream',
            fileInfo: {},
          },
        ],
      })),
      copyFile,
      copyLargeFile,
    } as unknown as Bucket
    const client = {
      accountInfo: {
        getRecommendedPartSize: () => 100,
        getAbsoluteMinimumPartSize: () => 100,
        getApiUrl: () => 'https://api.example.test',
        getAuthToken: () => 'auth-token',
      },
      raw: {
        startLargeFile,
        copyPart,
        finishLargeFile,
        cancelLargeFile,
      },
    } as unknown as B2Client

    await expect(
      copyCommand(client, bucket, {
        ...baseInputs('copy'),
        source: 'large-b2.bin',
        destination: 'large-b2-copy.bin',
        encryption: destinationEncryption,
        concurrency: 2,
      }),
    ).rejects.toThrow('part failed')
    releaseFirstPart?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(copyLargeFile).not.toHaveBeenCalled()
    expect(copyFile).not.toHaveBeenCalled()
    expect(copyPart.mock.calls.map((call) => call[2].partNumber)).toEqual([1, 2])
    expect(finishLargeFile).not.toHaveBeenCalled()
    expect(cancelLargeFile).toHaveBeenCalledWith('https://api.example.test', 'auth-token', {
      fileId: 'large-file-id',
    })
  })

  it('errors when source is missing', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'missing.txt',
        destination: 'wherever.txt',
      }),
    ).rejects.toThrow(/File not found/)
  })

  it('does not disclose hidden source existence in default logs', async () => {
    await seedFile(fx, 'private-copy.txt', 'secret')
    await fx.bucket.hideFile('private-copy.txt')

    const { error, stdout } = await captureFailure(() =>
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'private-copy.txt',
        destination: 'copy-target.txt',
      }),
    )

    expect(error.message).toBe(`File not found in bucket "${fx.bucket.name}": private-copy.txt`)
    expect(`${stdout}\n${error.message}`).not.toMatch(/File is hidden|hide marker|latest version/)
  })

  it('errors when destination is missing', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'whatever.txt',
      }),
    ).rejects.toThrow(/'destination' input is required/)
  })
})

describe('presign command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('returns a URL that points at the file', async () => {
    const local = join(fx.workDir, 'shareable.txt')
    await writeFile(local, 'share me')
    await uploadCommand(fx.bucket, {
      ...baseInputs('upload'),
      source: local,
      destination: 'shareable.txt',
    })

    const result = await presignCommand(fx.client, fx.bucket, {
      ...baseInputs('presign'),
      source: 'shareable.txt',
      presignTtlSeconds: 120,
    })

    expect(result.files).toHaveLength(1)
    const first = result.files[0]
    expect(first?.fileName).toBe('shareable.txt')
    expect(first?.url).toContain('/file/gh-action-misc/shareable.txt')
    expect(first?.url).toContain('Authorization=')
    expect(first?.url).toContain('expires=')
    expect(first?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})
