import { rm } from 'node:fs/promises'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildClient, getBucket } from '../src/client.ts'
import { listCommand } from '../src/commands/list.ts'
import { captureStdout, makeFixture, makeInputs, seedFile, type TestFixture } from './_helpers.ts'
import { TEST_APPLICATION_KEY, TEST_APPLICATION_KEY_ID } from './_parsed-inputs.ts'

const SHORT_AUTH_TOKEN_TTL_MS = 1000
const EXPIRED_TOKEN_ADVANCE_MS = SHORT_AUTH_TOKEN_TTL_MS + 1
// Safety cap for draining SDK retry timers; the tests do not assert the
// SDK's exact retry schedule, only that command promises settle under it.
const MAX_RETRY_TIMER_DRAIN_STEPS = 20

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
      const settlement = trackSettlement(resultPromise)
      await drainPendingRetryTimersUntilSettled(settlement)
      const result = await resultPromise

      expect(result.files).toHaveLength(1)
      expect(result.files[0]?.fileName).toBe('retry/ok.txt')
      expect(result.truncated).toBe(false)
    })

    it('surfaces sustained 429 rate limiting after the retry budget is exhausted', async () => {
      await seedFile(fx, 'limited/stuck.txt', 'stuck')
      const listAttempts = countSimulatorFaultChecks(fx.sim, 'b2_list_file_names')
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
      const settlement = trackSettlement(resultPromise)
      await expectPendingBeforeRetryBackoff(settlement)
      // Register the rejection handler before advancing timers so the final
      // retry rejection is caught instead of becoming an unhandled rejection.
      const rejection = expect(resultPromise).rejects.toThrow('rate limit still active')

      await drainPendingRetryTimersUntilSettled(settlement)
      await rejection
      expect(listAttempts()).toBeGreaterThan(1)
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

interface PromiseSettlement {
  isSettled(): boolean
}

function trackSettlement<T>(promise: Promise<T>): PromiseSettlement {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )

  return {
    isSettled: () => settled,
  }
}

async function expectPendingBeforeRetryBackoff(settlement: PromiseSettlement): Promise<void> {
  // Flush immediate promise work only; retry backoff timers must still be pending.
  await vi.advanceTimersByTimeAsync(0)

  expect(settlement.isSettled()).toBe(false)
}

async function drainPendingRetryTimersUntilSettled(settlement: PromiseSettlement): Promise<void> {
  for (let step = 0; step < MAX_RETRY_TIMER_DRAIN_STEPS && !settlement.isSettled(); step += 1) {
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
  }

  expect(settlement.isSettled()).toBe(true)
}

function countSimulatorFaultChecks(sim: B2Simulator, endpoint: string): () => number {
  type FaultCheckingSimulator = B2Simulator & {
    consumeMatchingFault(url: string): unknown
  }

  // Simulator faults are consumed before endpoint handling, so this observes
  // transport-level retry attempts without depending on retry delay durations.
  const patchedSim = sim as FaultCheckingSimulator
  const originalConsumeMatchingFault = patchedSim.consumeMatchingFault.bind(sim)
  let count = 0

  patchedSim.consumeMatchingFault = (url: string) => {
    if (url.includes(endpoint)) count += 1
    return originalConsumeMatchingFault(url)
  }

  return () => count
}
