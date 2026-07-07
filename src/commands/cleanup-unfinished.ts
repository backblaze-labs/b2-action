import * as core from '@actions/core'
import type { Bucket, LargeFileId } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'

/** One entry in {@link CleanupUnfinishedResult.files}. */
export interface CleanedUnfinishedUpload {
  /** B2 file name (the key) of the unfinished upload. */
  fileName: string
  /** B2 large-file ID assigned when the multipart upload started. */
  fileId: LargeFileId
  /** MIME type captured when the large file was started. */
  contentType: string
  /** Custom `X-Bz-Info-*` headers captured when the large file was started. */
  fileInfo: Record<string, string>
  /** Uploaded part count currently attached to the unfinished upload. */
  partCount: number
  /** Total bytes currently stored across uploaded parts. */
  size: number
  /** True for dry-run previews; the upload was not actually canceled. */
  skipped: boolean
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
 * `source` is treated as an optional B2 name prefix. Empty or omitted source
 * scans every unfinished upload in the bucket. With `dry-run: true`, no
 * cancellations happen; the action reports what would have been canceled.
 */
export async function cleanupUnfinishedCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<CleanupUnfinishedResult> {
  const prefix = inputs.source ?? ''
  const files: CleanedUnfinishedUpload[] = []
  let errors = 0

  core.startGroup(
    `${inputs.dryRun ? 'dry-run' : 'cleanup'} unfinished large uploads b2://${bucket.name}/${prefix}`,
  )
  try {
    for await (const unfinished of bucket.paginateUnfinishedLargeFiles({
      ...(prefix !== '' ? { namePrefix: prefix } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })) {
      signal?.throwIfAborted()
      const parts = await summarizeParts(bucket, unfinished.fileId, signal)
      const entry: CleanedUnfinishedUpload = {
        fileName: unfinished.fileName,
        fileId: unfinished.fileId,
        contentType: unfinished.contentType,
        fileInfo: unfinished.fileInfo,
        partCount: parts.count,
        size: parts.bytes,
        skipped: inputs.dryRun,
      }

      if (inputs.dryRun) {
        files.push(entry)
        core.info(
          `  would cancel ${entry.fileName} (${entry.fileId}; ${entry.partCount} part(s), ${entry.size} bytes)`,
        )
        continue
      }

      try {
        await bucket.cancelLargeFile(unfinished.fileId)
        files.push(entry)
        core.info(
          `  canceled ${entry.fileName} (${entry.fileId}; ${entry.partCount} part(s), ${entry.size} bytes)`,
        )
      } catch {
        errors++
        core.warning(`  failed to cancel ${entry.fileName} (${entry.fileId}): cancel failed`)
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
): Promise<{ count: number; bytes: number }> {
  let count = 0
  let bytes = 0

  for await (const part of bucket.paginateParts(fileId, {
    ...(signal !== undefined ? { signal } : {}),
  })) {
    count++
    bytes += part.contentLength
  }

  return { count, bytes }
}
