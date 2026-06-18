import { rm } from 'node:fs/promises'
import type { HttpTransport } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { describe, expect, it } from 'vitest'
import { buildClient, findFileByName, getBucket } from '../src/client.ts'
import { captureStdout, makeFixture, seedFile } from './_helpers.ts'

describe('client helpers', () => {
  it('builds an authorized simulator-backed client and masks the auth token', async () => {
    const sim = new B2Simulator()
    let authorized: Awaited<ReturnType<typeof buildClient>> | undefined

    const stdout = await captureStdout(async () => {
      authorized = await buildClient({
        applicationKeyId: 'test-key-id',
        applicationKey: 'test-key',
        bucket: 'client-bucket',
        endpoint: 'https://staging.example',
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

  it('resolves buckets by name and reports a clear missing-bucket error', async () => {
    const fx = await makeFixture('client-helper-bucket')
    try {
      const found = await getBucket({ client: fx.client, bucketName: fx.bucket.name })
      expect(found.id).toBe(fx.bucket.id)
      expect(found.name).toBe(fx.bucket.name)
      const missingClient = { getBucket: async () => null }
      await expect(
        getBucket({ client: missingClient as never, bucketName: 'missing-bucket' }),
      ).rejects.toThrow(/Bucket "missing-bucket" not found/)
    } finally {
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })

  it('finds the latest visible file version and rejects missing files', async () => {
    const fx = await makeFixture('client-find-file')
    try {
      await seedFile(fx, 'visible.txt', 'hello')

      await expect(findFileByName(fx.bucket, 'visible.txt')).resolves.toMatchObject({
        fileName: 'visible.txt',
        action: 'upload',
      })
      await expect(findFileByName(fx.bucket, 'missing.txt')).rejects.toThrow(
        /File not found in bucket "client-find-file": missing.txt/,
      )
    } finally {
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })
})
