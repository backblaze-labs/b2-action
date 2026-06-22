import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import * as core from '@actions/core'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import { IncrementalSha1 } from '@backblaze-labs/b2-sdk/streams'
import { type ParsedInputs, requireSource } from '../inputs.ts'

/** Result of {@link verifyCommand}. */
export interface VerifyResult {
  /** B2 file name that was checked. */
  fileName: string
  /** Server-reported byte size of the remote object. */
  remoteSize: number
  /** Remote SHA-1 header value, or `null` if B2 does not expose one. */
  remoteSha1: string | null
  /** Locally-computed SHA-1, or `null` if no local file was provided. */
  localSha1: string | null
  /** True when remote SHA-1 matches the expected value. */
  verified: boolean
  /** Human-readable failure reason; `undefined` on success. */
  reason: string | undefined
}

/**
 * Verify that a B2 object matches a local file (or an expected SHA-1) without
 * transferring the body.
 *
 * Three modes, in priority order:
 *   1. `expected-sha1` input set → compare the remote object's SHA-1 to that
 *      literal value. No local read.
 *   2. `destination` input is an existing local file → compute that file's
 *      SHA-1 locally and compare to the remote.
 *   3. Neither → fail.
 *
 * In all modes, the remote SHA-1 is fetched via a HEAD request (header
 * `x-bz-content-sha1`). Large files uploaded via multipart return `null` from
 * B2 here because B2 stores the per-part SHA-1s but not a whole-file SHA-1;
 * HEAD-only verification cannot validate those objects, even when
 * `expected-sha1` is supplied.
 */
export async function verifyCommand(bucket: Bucket, inputs: ParsedInputs): Promise<VerifyResult> {
  const source = requireSource(inputs.source, 'verify', 'the B2 file name')

  core.startGroup(`verify b2://${bucket.name}/${source}`)
  try {
    // `bucket.head` returns only the parsed response headers; no body to
    // drain. The SDK normalizes multipart `'none'` to `null` at the boundary.
    const { headers } = await bucket.head(source)
    const remoteSize = headers.contentLength
    const remoteSha1 = headers.contentSha1

    let localSha1: string | null = null
    let expected: string | null =
      inputs.expectedSha1 !== undefined ? normalizeSha1(inputs.expectedSha1, 'expected-sha1') : null

    if (expected === null && inputs.destination !== undefined && inputs.destination !== '') {
      localSha1 = await sha1OfFile(inputs.destination)
      expected = normalizeSha1(localSha1, 'destination')
    }

    if (expected === null) {
      throw new Error(
        "verify needs either 'expected-sha1' (literal) or 'destination' (local file path) to compare against",
      )
    }

    const normalizedRemoteSha1 = remoteSha1 === null ? null : normalizeRemoteSha1(remoteSha1)
    if (normalizedRemoteSha1 === null) {
      const reason = unavailableRemoteSha1Reason(remoteSha1)
      core.warning(`  ${reason}`)
      return {
        fileName: source,
        remoteSize,
        remoteSha1,
        localSha1,
        verified: false,
        reason,
      }
    }

    const verified = normalizedRemoteSha1 === expected
    const reason = verified
      ? undefined
      : `SHA-1 mismatch: remote=${normalizedRemoteSha1} expected=${expected}`
    if (verified) {
      core.info(`  ✓ SHA-1 matches (${normalizedRemoteSha1}), size=${remoteSize}B`)
    } else {
      core.warning(`  ${reason}`)
    }

    return {
      fileName: source,
      remoteSize,
      remoteSha1: normalizedRemoteSha1,
      localSha1,
      verified,
      reason,
    }
  } finally {
    core.endGroup()
  }
}

/**
 * Normalize and validate a SHA-1 digest for case-insensitive comparison.
 *
 * @internal
 */
export function normalizeSha1(raw: string, label = 'SHA-1'): string {
  const normalized = raw.trim().toLowerCase()
  if (!/^[a-f0-9]{40}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: expected a 40-character hexadecimal SHA-1 digest`)
  }
  return normalized
}

function normalizeRemoteSha1(raw: string): string | null {
  const normalized = raw.trim().toLowerCase()
  return /^[a-f0-9]{40}$/.test(normalized) ? normalized : null
}

function unavailableRemoteSha1Reason(remoteSha1: string | null): string {
  if (remoteSha1 === null) {
    return 'remote SHA-1 is unavailable because B2 does not expose a whole-file SHA-1 for multipart-uploaded files; HEAD-only verify cannot validate this object, even with expected-sha1'
  }
  return `remote SHA-1 is unavailable because B2 reported ${JSON.stringify(remoteSha1)} instead of a verified 40-character whole-file SHA-1; HEAD-only verify cannot validate this object, even with expected-sha1`
}

async function sha1OfFile(path: string): Promise<string> {
  const fileStat = await stat(path)
  if (!fileStat.isFile()) {
    throw new Error(`verify: 'destination' must be an existing file, got: ${path}`)
  }
  const hasher = new IncrementalSha1()
  const stream = createReadStream(path)
  for await (const chunk of stream) {
    await hasher.update(chunk as Uint8Array)
  }
  return hasher.digest()
}
