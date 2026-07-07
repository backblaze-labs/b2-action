import * as core from '@actions/core'
import type { Bucket, LargeFileId } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'

const PART_DIAGNOSTIC_LIMIT = 100

export type CleanupUnfinishedStatus =
  | 'canceled'
  | 'would-cancel'
  | 'skipped-active'
  | 'skipped-unknown'
  | 'failed'

export interface CleanupFailureDiagnostic {
  message: 'cancel failed'
  status?: number
  code?: string
  retryable?: boolean
  retryAfter?: number
}

/** One entry in {@link CleanupUnfinishedResult.files}. */
export interface CleanedUnfinishedUpload {
  /** B2 file name (the key) of the unfinished upload. */
  fileName: string
  /** B2 large-file ID assigned when the multipart upload started. */
  fileId: LargeFileId
  /** Uploaded part count currently attached to the unfinished upload, when known. */
  partCount: number | null
  /** Total bytes currently stored across uploaded parts, when known. */
  size: number | null
  /** Whether part diagnostics hit the bounded scan budget. */
  partsTruncated?: boolean
  /** The cleanup decision for this upload. */
  status: CleanupUnfinishedStatus
  /** Machine-readable reason for skipped uploads. */
  reason?: 'recent-parts' | 'no-parts' | 'parts-truncated' | 'parts-scan-failed'
  /** Sanitized cancel-failure diagnostics. Present only when `status` is `failed`. */
  error?: CleanupFailureDiagnostic
}

/** Result of {@link cleanupUnfinishedCommand}. */
export interface CleanupUnfinishedResult {
  /** One entry per matched unfinished large upload. */
  files: CleanedUnfinishedUpload[]
  /** Count of individual cancel failures. */
  errors: number
}

/**
 * List and cancel unfinished large file uploads.
 *
 * `source` is treated as an optional B2 name prefix. Empty, omitted, or `/`
 * source scans the whole bucket only for dry-runs or when
 * `allow-bucket-cleanup: true` is set. By default, non-dry-run cleanup also
 * skips uploads whose parts look active or whose part diagnostics are
 * incomplete; `cleanup-unfinished-force: true` opts into canceling those
 * matches.
 */
export async function cleanupUnfinishedCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<CleanupUnfinishedResult> {
  const bucketWide = inputs.source === undefined || inputs.source === '' || inputs.source === '/'
  if (bucketWide && !inputs.dryRun && !inputs.allowBucketCleanup) {
    throw new Error(
      "'allow-bucket-cleanup' must be true for whole-bucket cleanup-unfinished (set 'source' to a prefix for scoped cleanup)",
    )
  }

  const prefix = bucketWide ? '' : (inputs.source ?? '')
  const files: CleanedUnfinishedUpload[] = []
  let errors = 0
  const now = Date.now()

  core.startGroup(
    `${inputs.dryRun ? 'dry-run' : 'cleanup'} unfinished large uploads b2://${bucket.name}/${prefix}`,
  )
  try {
    if (prefix === '' && !inputs.dryRun) {
      core.warning(
        `cleanup-unfinished will cancel unfinished uploads across bucket "${bucket.name}". Continuing because allow-bucket-cleanup is true.`,
      )
    }
    if (inputs.cleanupUnfinishedForce && !inputs.dryRun) {
      core.warning(
        'cleanup-unfinished-force is true; active or diagnostically unknown uploads may be canceled.',
      )
    }

    for await (const unfinished of bucket.paginateUnfinishedLargeFiles({
      ...(prefix !== '' ? { namePrefix: prefix } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      signal?.throwIfAborted()
      const parts = await summarizeParts(bucket, unfinished.fileId, signal)
      const baseEntry = {
        fileName: unfinished.fileName,
        fileId: unfinished.fileId,
        partCount: parts.partCount,
        size: parts.size,
        ...(parts.truncated ? { partsTruncated: true } : {}),
      }
      const guard = cleanupGuard(parts, inputs, now)
      if (guard !== undefined) {
        files.push({
          ...baseEntry,
          status: guard.status,
          reason: guard.reason,
        })
        core.info(`  skipped ${unfinished.fileName} (${unfinished.fileId}): ${guard.message}`)
        continue
      }

      if (inputs.dryRun) {
        const entry = {
          ...baseEntry,
          status: 'would-cancel' as const,
        }
        files.push(entry)
        core.info(`  would cancel ${entry.fileName} (${entry.fileId}; ${formatPartSummary(entry)})`)
        continue
      }

      try {
        await bucket.cancelLargeFile(unfinished.fileId)
        const entry = {
          ...baseEntry,
          status: 'canceled' as const,
        }
        files.push(entry)
        core.info(`  canceled ${entry.fileName} (${entry.fileId}; ${formatPartSummary(entry)})`)
      } catch (error) {
        errors++
        const diagnostic = cleanupFailureDiagnostic(error)
        files.push({
          ...baseEntry,
          status: 'failed',
          error: diagnostic,
        })
        core.warning(
          `  failed to cancel ${unfinished.fileName} (${unfinished.fileId}): ${formatFailureDiagnostic(diagnostic)}`,
        )
      }
    }
  } finally {
    core.info(`  ${files.length} unfinished large upload(s) matched`)
    core.endGroup()
  }

  return { files, errors }
}

async function summarizeParts(
  bucket: Bucket,
  fileId: LargeFileId,
  signal?: AbortSignal,
): Promise<{
  partCount: number | null
  size: number | null
  latestUploadTimestamp: number | null
  truncated: boolean
  failed: boolean
}> {
  let partCount = 0
  let size = 0
  let latestUploadTimestamp: number | null = null

  try {
    const iterator = bucket
      .paginateParts(fileId, {
        pageSize: PART_DIAGNOSTIC_LIMIT,
        ...(signal !== undefined ? { signal } : {}),
      })
      [Symbol.asyncIterator]()

    while (true) {
      const next = await iterator.next()
      if (next.done === true) break
      if (partCount >= PART_DIAGNOSTIC_LIMIT) {
        return {
          partCount,
          size,
          latestUploadTimestamp,
          truncated: true,
          failed: false,
        }
      }
      partCount++
      size += next.value.contentLength
      if (isFiniteNonNegativeNumber(next.value.uploadTimestamp)) {
        latestUploadTimestamp = Math.max(
          latestUploadTimestamp ?? Number.NEGATIVE_INFINITY,
          next.value.uploadTimestamp,
        )
      }
    }
  } catch {
    signal?.throwIfAborted()
    core.warning(`  failed to inspect parts for ${fileId}; treating part count and size as unknown`)
    return {
      partCount: null,
      size: null,
      latestUploadTimestamp: null,
      truncated: false,
      failed: true,
    }
  }

  return {
    partCount,
    size,
    latestUploadTimestamp,
    truncated: false,
    failed: false,
  }
}

function cleanupGuard(
  parts: Awaited<ReturnType<typeof summarizeParts>>,
  inputs: ParsedInputs,
  now: number,
):
  | {
      status: 'skipped-active' | 'skipped-unknown'
      reason: NonNullable<CleanedUnfinishedUpload['reason']>
      message: string
    }
  | undefined {
  if (inputs.cleanupUnfinishedForce) return undefined
  if (parts.failed) {
    return {
      status: 'skipped-unknown',
      reason: 'parts-scan-failed',
      message: 'part diagnostics failed; set cleanup-unfinished-force to cancel anyway',
    }
  }
  if (parts.truncated) {
    return {
      status: 'skipped-unknown',
      reason: 'parts-truncated',
      message: `part diagnostics reached the ${PART_DIAGNOSTIC_LIMIT}-part cap; set cleanup-unfinished-force to cancel anyway`,
    }
  }
  if (parts.partCount === 0 || parts.latestUploadTimestamp === null) {
    return {
      status: 'skipped-unknown',
      reason: 'no-parts',
      message:
        'no uploaded parts or part timestamps found; set cleanup-unfinished-force to cancel anyway',
    }
  }
  const idleMs = inputs.cleanupUnfinishedIdleMinutes * 60 * 1000
  if (now - parts.latestUploadTimestamp < idleMs) {
    return {
      status: 'skipped-active',
      reason: 'recent-parts',
      message: `latest part is newer than cleanup-unfinished-idle-minutes (${inputs.cleanupUnfinishedIdleMinutes})`,
    }
  }
  return undefined
}

function cleanupFailureDiagnostic(error: unknown): CleanupFailureDiagnostic {
  const details = error as {
    status?: unknown
    code?: unknown
    retryable?: unknown
    retryAfter?: unknown
  }
  return {
    message: 'cancel failed',
    ...(isFiniteNonNegativeNumber(details.status) ? { status: Math.trunc(details.status) } : {}),
    ...(typeof details.code === 'string' ? { code: safeDiagnosticToken(details.code) } : {}),
    ...(typeof details.retryable === 'boolean' ? { retryable: details.retryable } : {}),
    ...(isFiniteNonNegativeNumber(details.retryAfter)
      ? { retryAfter: Math.ceil(details.retryAfter) }
      : {}),
  }
}

function formatFailureDiagnostic(diagnostic: CleanupFailureDiagnostic): string {
  const details = [
    diagnostic.status !== undefined ? `status ${diagnostic.status}` : undefined,
    diagnostic.code !== undefined ? `code ${diagnostic.code}` : undefined,
    diagnostic.retryable !== undefined ? `retryable ${diagnostic.retryable}` : undefined,
    diagnostic.retryAfter !== undefined ? `retry after ${diagnostic.retryAfter}s` : undefined,
  ].filter((value): value is string => value !== undefined)
  return details.length > 0 ? `${diagnostic.message} (${details.join(', ')})` : diagnostic.message
}

function formatPartSummary(entry: Pick<CleanedUnfinishedUpload, 'partCount' | 'size'>): string {
  const parts = entry.partCount === null ? 'unknown part count' : `${entry.partCount} part(s)`
  const bytes = entry.size === null ? 'unknown bytes' : `${entry.size} bytes`
  return `${parts}, ${bytes}`
}

function safeDiagnosticToken(value: string): string {
  const normalized = value.trim()
  if (
    /(authorization|application.?key|password|private.?key|secret|signature|token)/i.test(
      normalized,
    )
  ) {
    return 'unknown'
  }
  if (/^[A-Za-z0-9_.-]{1,80}$/.test(normalized)) return normalized
  return 'unknown'
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
