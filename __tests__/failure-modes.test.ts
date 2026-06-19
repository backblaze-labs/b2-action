import { rm } from 'node:fs/promises'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClient, getBucket } from '../src/client.ts'
import { listCommand } from '../src/commands/list.ts'
import { captureStdout, makeFixture, makeInputs, seedFile, type TestFixture } from './_helpers.ts'
import { TEST_APPLICATION_KEY, TEST_APPLICATION_KEY_ID } from './_parsed-inputs.ts'

const SHORT_AUTH_TOKEN_TTL_MS = 1000
const EXPIRED_TOKEN_ADVANCE_MS = SHORT_AUTH_TOKEN_TTL_MS + 1
// The SDK's first retry delay is about 1s plus jitter; this clears one retry
// without letting the test wait on wall-clock backoff.
const SINGLE_RETRY_TIMER_FLUSH_MS = 5000
// The SDK's default retry budget is 5 attempts with exponential backoff. This
// window is intentionally above that full schedule so the final 429 surfaces.
const RETRY_BUDGET_EXHAUSTION_FLUSH_MS = 120_000

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
    const sim = new B2Simulator({
      strictAuth: true,
      authTokenTtlMs: SHORT_AUTH_TOKEN_TTL_MS,
    })
    const authorized = await buildClient({
      applicationKeyId: TEST_APPLICATION_KEY_ID,
      applicationKey: TEST_APPLICATION_KEY,
      bucket: bucketName,
      transport: sim.transport(),
    })
    await authorized.client.createBucket({ bucketName, bucketType: 'allPrivate' })
    const originalToken = currentSdkAuthToken(authorized)

    sim.advanceTime(EXPIRED_TOKEN_ADVANCE_MS)

    let foundBucketName: string | undefined
    const reauthStdout = await captureStdout(async () => {
      foundBucketName = (await getBucket(authorized)).name
    })
    const refreshedToken = currentSdkAuthToken(authorized)

    expect(foundBucketName).toBe(bucketName)
    expect(refreshedToken).not.toBe(originalToken)
    expect(reauthStdout).toContain(`::add-mask::${refreshedToken}`)
  })

  describe('representative command retry behavior', () => {
    let fx: TestFixture

    beforeEach(async () => {
      fx = await makeFixture('failure-mode-retry')
    })

    afterEach(async () => {
      vi.useRealTimers()
      await rm(fx.workDir, { recursive: true, force: true })
    })

    it.each([
      { status: 429, code: 'too_many_requests', message: 'rate limited' },
      { status: 503, code: 'service_unavailable', message: 'service unavailable' },
    ])('retries transient $status responses', async (fault) => {
      await seedFile(fx, 'retry/ok.txt', 'ok')
      fx.sim.injectFailure({
        on: 'b2_list_file_names',
        status: fault.status,
        code: fault.code,
        message: fault.message,
        count: 1,
      })
      // SDK retry backoff sleeps with real timers; fake timers keep this fast.
      vi.useFakeTimers()

      const resultPromise = listCommand(
        fx.bucket,
        makeInputs('list', fx, { source: 'retry/', maxResults: 10 }),
      )
      await vi.advanceTimersByTimeAsync(SINGLE_RETRY_TIMER_FLUSH_MS)
      const result = await resultPromise

      expect(result.files).toHaveLength(1)
      expect(result.files[0]?.fileName).toBe('retry/ok.txt')
      expect(result.truncated).toBe(false)
    })

    it('surfaces sustained 429 rate limiting after the retry budget is exhausted', async () => {
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
      // Register the rejection handler before advancing timers so the final
      // retry rejection is caught instead of becoming an unhandled rejection.
      const rejection = expect(resultPromise).rejects.toThrow('rate limit still active')

      await vi.advanceTimersByTimeAsync(RETRY_BUDGET_EXHAUSTION_FLUSH_MS)
      await rejection
    })
  })
})

function currentSdkAuthToken(authorized: Awaited<ReturnType<typeof buildClient>>): string {
  // Token inspection is intentional here: the action must mask the exact
  // rotated token value that the SDK stores after automatic reauthorization.
  const token = authorized.client.accountInfo.getAuthToken()
  expect(token).toBeTruthy()
  return token
}
