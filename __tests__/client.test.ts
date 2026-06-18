import { rm } from 'node:fs/promises'
import type { HttpTransport } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClient, findFileByName, getBucket } from '../src/client.ts'
import { captureStdout, makeFixture, seedFile, type TestFixture } from './_helpers.ts'
import { TEST_APPLICATION_KEY, TEST_APPLICATION_KEY_ID, TEST_ENDPOINT } from './_parsed-inputs.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  vi.doUnmock('@actions/core')
  vi.doUnmock('@backblaze-labs/b2-sdk')
})

describe('client helpers', () => {
  it('builds an authorized simulator-backed client and masks the auth token', async () => {
    const sim = new B2Simulator()
    let authorized: Awaited<ReturnType<typeof buildClient>> | undefined

    const stdout = await captureStdout(async () => {
      authorized = await buildClient({
        applicationKeyId: TEST_APPLICATION_KEY_ID,
        applicationKey: TEST_APPLICATION_KEY,
        bucket: 'client-bucket',
        endpoint: TEST_ENDPOINT,
        transport: sim.transport(),
      })
    })

    expect(authorized?.bucketName).toBe('client-bucket')
    expect(authorized?.client.accountInfo.getAuthToken()).toBeTruthy()
    expect(stdout).toContain('::add-mask::')
  })

  it('surfaces authorization failures from the SDK', async () => {
    const transport: HttpTransport = {
      async send() {
        return {
          status: 401,
          headers: new Headers(),
          body: null,
          async json<T>() {
            return { status: 401, code: 'unauthorized', message: 'nope' } as T
          },
          async text() {
            return '{"status":401,"code":"unauthorized","message":"nope"}'
          },
          async arrayBuffer() {
            return new ArrayBuffer(0)
          },
        }
      },
    }

    await expect(
      buildClient({
        applicationKeyId: 'bad-key-id',
        applicationKey: 'bad-key',
        bucket: 'client-bucket',
        transport,
      }),
    ).rejects.toThrow(/nope|unauthorized/i)
  })

  it('maps optional SDK constructor fields and skips empty-token masking', async () => {
    const core = { setSecret: vi.fn() }
    const constructedOptions: unknown[] = []
    class FakeB2Client {
      accountInfo = { getAuthToken: () => '' }

      constructor(options: unknown) {
        constructedOptions.push(options)
      }

      async authorize() {}
    }

    vi.doMock('@actions/core', () => core)
    vi.doMock('@backblaze-labs/b2-sdk', () => ({ B2Client: FakeB2Client }))

    const { buildClient: buildMockedClient } = await import('../src/client.ts')
    const result = await buildMockedClient({
      applicationKeyId: 'mock-key-id',
      applicationKey: 'mock-key',
      bucket: 'mock-bucket',
    })

    expect(result.bucketName).toBe('mock-bucket')
    expect(constructedOptions[0]).toMatchObject({
      applicationKeyId: 'mock-key-id',
      applicationKey: 'mock-key',
    })
    expect(constructedOptions[0]).not.toHaveProperty('transport')
    expect(constructedOptions[0]).not.toHaveProperty('realm')
    expect(core.setSecret).not.toHaveBeenCalled()

    await buildMockedClient({
      applicationKeyId: 'mock-key-id',
      applicationKey: 'mock-key',
      bucket: 'endpoint-bucket',
      endpoint: TEST_ENDPOINT,
    })

    expect(constructedOptions[1]).toMatchObject({
      realm: TEST_ENDPOINT,
    })
  })

  describe('fixture-backed helpers', () => {
    const BUCKET = 'client-helper-bucket'
    let fx: TestFixture

    beforeEach(async () => {
      fx = await makeFixture(BUCKET)
    })

    afterEach(async () => {
      await rm(fx.workDir, { recursive: true, force: true })
    })

    it('resolves buckets by name and reports a clear missing-bucket error', async () => {
      const found = await getBucket({ client: fx.client, bucketName: fx.bucket.name })
      expect(found.id).toBe(fx.bucket.id)
      expect(found.name).toBe(fx.bucket.name)
      const missingClient = { getBucket: async () => null }
      await expect(
        getBucket({ client: missingClient as never, bucketName: 'missing-bucket' }),
      ).rejects.toThrow(/Bucket "missing-bucket" not found/)
    })

    it('finds the latest visible file version and rejects missing files', async () => {
      await seedFile(fx, 'visible.txt', 'hello')

      await expect(findFileByName(fx.bucket, 'visible.txt')).resolves.toMatchObject({
        fileName: 'visible.txt',
        action: 'upload',
      })
      await expect(findFileByName(fx.bucket, 'missing.txt')).rejects.toThrow(
        `File not found in bucket "${BUCKET}": missing.txt`,
      )
      await expect(findFileByName(fx.bucket, 'source.txt', 'source-bucket')).rejects.toThrow(
        /File not found in bucket "source-bucket": source.txt/,
      )
    })

    it('rejects hidden files whose latest version is a hide marker', async () => {
      await seedFile(fx, 'hidden.txt', 'hello')
      await fx.bucket.hideFile('hidden.txt')

      await expect(findFileByName(fx.bucket, 'hidden.txt')).rejects.toThrow(
        `File not found in bucket "${BUCKET}": hidden.txt`,
      )
    })

    it('rejects prefix matches that are not exact file names', async () => {
      await seedFile(fx, 'report.csv.bak', 'x')

      await expect(findFileByName(fx.bucket, 'report.csv')).rejects.toThrow(
        `File not found in bucket "${BUCKET}": report.csv`,
      )
    })
  })
})
