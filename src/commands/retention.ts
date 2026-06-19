import * as core from '@actions/core'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import { findFileByName } from '../client.ts'
import { type ParsedInputs, requireSource } from '../inputs.ts'

/** Result of {@link retentionCommand}: describes what was applied to the target version. */
export interface RetentionResult {
  /** B2 file name the retention/hold was applied to. */
  fileName: string
  /** B2 file ID of the version that was modified. */
  fileId: string
  /** Retention mode after the call. `none` means retention was cleared. Undefined if only legal-hold was touched. */
  appliedMode: 'compliance' | 'governance' | 'none' | undefined
  /** Retention expiration timestamp (ms since the epoch). `null` when mode is `none`. */
  retainUntilTimestamp: number | null | undefined
  /** Legal-hold state after the call. Undefined when not touched by this invocation. */
  appliedLegalHold: 'on' | 'off' | undefined
}

/**
 * Apply Object Lock retention settings and/or a legal hold to a specific
 * file version.
 *
 * The bucket must have Object Lock enabled. Three inputs drive this command:
 *   - `retention-mode`: `compliance` | `governance` | `none`. Required if
 *     `retention-until` is set.
 *   - `retention-until`: ISO 8601 timestamp (e.g. `2027-01-01T00:00:00Z`).
 *     Required if `retention-mode` is `compliance` or `governance`.
 *   - `legal-hold`: `on` | `off`. Independent of retention; can be set on
 *     its own or alongside retention.
 *   - `bypass-governance` (bool): allows shortening a governance retention.
 *
 * At least one of `retention-mode` / `legal-hold` must be supplied.
 *
 * The target file version is resolved by exact name only when the latest
 * version is an upload.
 */
export async function retentionCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
): Promise<RetentionResult> {
  const source = requireSource(inputs.source, 'retention', 'the B2 file name')

  const mode = inputs.retentionMode
  const until = inputs.retentionUntil
  const legalHold = inputs.legalHold

  if (mode === undefined && legalHold === undefined) {
    throw new Error("retention requires at least one of 'retention-mode' or 'legal-hold' to be set")
  }

  // Resolve the retention expiration up front so TypeScript narrows `until`
  // inside the parse branch and the downstream call site doesn't need a cast.
  let retainUntilMillis: number | null = null
  if (mode === 'compliance' || mode === 'governance') {
    if (until === undefined) {
      throw new Error(
        `'retention-until' (ISO 8601 timestamp) is required when 'retention-mode' is '${mode}'`,
      )
    }
    const parsed = Date.parse(until)
    if (Number.isNaN(parsed)) {
      throw new Error(`'retention-until' is not a valid ISO 8601 timestamp: "${until}"`)
    }
    // Reject past timestamps client-side. B2 also rejects them server-side
    // but with a generic 400; the action's check fails faster and tells the
    // user exactly what's wrong (especially helpful for timezone-skewed CI
    // runners). Allow a small clock-skew tolerance: anything within the
    // last 30 seconds is treated as "now" rather than past.
    const skewToleranceMs = 30_000
    if (parsed < Date.now() - skewToleranceMs) {
      throw new Error(
        `'retention-until' must be in the future; got "${until}" (${new Date(parsed).toISOString()})`,
      )
    }
    retainUntilMillis = parsed
  }

  // Resolve the file version we're operating on.
  const hit = await findFileByName(bucket, source)

  let appliedMode: RetentionResult['appliedMode']
  let retainUntilTimestamp: number | null | undefined
  let appliedLegalHold: RetentionResult['appliedLegalHold']

  core.startGroup(`retention b2://${bucket.name}/${source}`)
  try {
    if (mode !== undefined) {
      const retention = {
        mode: mode === 'none' ? null : mode,
        retainUntilTimestamp: retainUntilMillis,
      }
      const result = inputs.bypassGovernance
        ? await bucket.updateFileRetention(source, hit.fileId, retention, {
            bypassGovernance: true,
          })
        : await bucket.updateFileRetention(source, hit.fileId, retention)
      appliedMode = mode
      retainUntilTimestamp = result.fileRetention.retainUntilTimestamp
      core.info(`  retention: mode=${mode} retainUntil=${retainUntilMillis}`)
    }

    if (legalHold !== undefined) {
      const result = await bucket.updateFileLegalHold(source, hit.fileId, legalHold)
      appliedLegalHold = result.legalHold
      core.info(`  legal-hold: ${result.legalHold}`)
    }

    return {
      fileName: source,
      fileId: hit.fileId,
      appliedMode,
      retainUntilTimestamp,
      appliedLegalHold,
    }
  } finally {
    core.endGroup()
  }
}
