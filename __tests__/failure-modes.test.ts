import { rm } from 'node:fs/promises'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { describe, expect, it, vi } from 'vitest'
import { buildClient, getBucket } from '../src/client.ts'
import { listCommand } from '../src/commands/list.ts'
import { makeFixture, makeInputs, seedFile } from './_helpers.ts'
import { TEST_APPLICATION_KEY, TEST_APPLICATION_KEY_ID } from './_parsed-inputs.ts'

describe('action-layer B2 failure modes', () => {
  it('surfaces simulator authorization failures with the B2 error message', async () => {
    const sim = new B2Simulator()
    sim.injectFailure({
      on: 'b2_authorize_account',
      status: 401,
      code: 'unauthorized',
      message: 'bad application key',
    })

    await expect(
      buildClient({
        applicationKeyId: 'bad-key-id',
        applicationKey: 'bad-key',
        bucket: 'failure-auth-bucket',
        transport: sim.transport(),
      }),
    ).rejects.toThrow('bad application key')
  })

  it('reauthorizes and retries when a bucket lookup sees an expired token', async () => {
    const bucketName = 'failure-reauth-bucket'
    const sim = new B2Simulator({ strictAuth: true, authTokenTtlMs: 1000 })
    const authorized = await buildClient({
      applicationKeyId: TEST_APPLICATION_KEY_ID,
      applicationKey: TEST_APPLICATION_KEY,
      bucket: bucketName,
      transport: sim.transport(),
    })
    await authorized.client.createBucket({ bucketName, bucketType: 'allPrivate' })
    const originalToken = authorized.client.accountInfo.getAuthToken()

    sim.advanceTime(1001)

    const bucket = await getBucket(authorized)

    expect(bucket.name).toBe(bucketName)
    expect(authorized.client.accountInfo.getAuthToken()).toBeTruthy()
    expect(authorized.client.accountInfo.getAuthToken()).not.toBe(originalToken)
  })

  it.each([
    { status: 429, code: 'too_many_requests', message: 'rate limited' },
    { status: 503, code: 'service_unavailable', message: 'service unavailable' },
  ])('retries transient $status responses from a representative command', async (fault) => {
    const fx = await makeFixture(`failure-mode-${fault.status}`)
    try {
      await seedFile(fx, 'retry/ok.txt', 'ok')
      fx.sim.injectFailure({
        on: 'b2_list_file_names',
        status: fault.status,
        code: fault.code,
        message: fault.message,
        count: 1,
      })
      vi.useFakeTimers()

      const resultPromise = listCommand(
        fx.bucket,
        makeInputs('list', fx, { source: 'retry/', maxResults: 10 }),
      )
      await vi.advanceTimersByTimeAsync(5000)
      const result = await resultPromise

      expect(result.files).toHaveLength(1)
      expect(result.files[0]?.fileName).toBe('retry/ok.txt')
      expect(result.truncated).toBe(false)
    } finally {
      vi.useRealTimers()
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })

  it('surfaces sustained 429 rate limiting after the retry budget is exhausted', async () => {
    const fx = await makeFixture('failure-mode-rate-limit')
    try {
      await seedFile(fx, 'limited/stuck.txt', 'stuck')
      fx.sim.injectFailure({
        on: 'b2_list_file_names',
        status: 429,
        code: 'too_many_requests',
        message: 'rate limit still active',
      })
      vi.useFakeTimers()

      const resultPromise = listCommand(
        fx.bucket,
        makeInputs('list', fx, { source: 'limited/', maxResults: 10 }),
      )
      const rejection = expect(resultPromise).rejects.toThrow('rate limit still active')

      await vi.advanceTimersByTimeAsync(120_000)
      await rejection
    } finally {
      vi.useRealTimers()
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })
})
