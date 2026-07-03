import * as core from '@actions/core'
import type { B2Client, Bucket } from '@backblaze-labs/b2-sdk'
import { findFileByName } from '../client.ts'
import { type ParsedInputs, requireSource } from '../inputs.ts'

/** Result of {@link copyCommand}. Single-file (copy is always one-source-one-destination). */
export interface CopyResult {
  /** Source bucket name. */
  sourceBucket: string
  /** Source file name (the B2 key in the source bucket). */
  sourceFileName: string
  /** Destination bucket name. */
  destinationBucket: string
  /** Destination file name (the B2 key in the destination bucket). */
  destinationFileName: string
  /** B2 file ID of the newly-created destination object. */
  fileId: string
  /** Byte size of the copied object. */
  size: number
}

/**
 * Server-side copy of one B2 object to a new name, within the same bucket or
 * across two buckets in the same account.
 *
 * The copy is done by reference (`b2_copy_file` for small, `b2_copy_part` for
 * large): bytes never traverse the runner. This is dramatically faster and
 * cheaper than download-then-reupload for any non-trivial file.
 *
 * Cross-bucket: set `source-bucket` to the source bucket name. The action's
 * `bucket` input is the destination. The application key must have read
 * permission on the source bucket and write permission on the destination.
 */
export async function copyCommand(
  client: B2Client,
  destinationBucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<CopyResult> {
  const source = requireSource(inputs.source, 'copy', 'the source B2 file name')
  const destination = inputs.destination
  if (destination === undefined || destination === '') {
    throw new Error(
      "'destination' input is required for 'copy' action (the destination B2 file name)",
    )
  }

  const sourceBucketName = inputs.sourceBucket ?? destinationBucket.name
  const sourceBucket =
    sourceBucketName === destinationBucket.name
      ? destinationBucket
      : await client.getBucket(sourceBucketName)
  if (!sourceBucket) {
    throw new Error(`Source bucket "${sourceBucketName}" not found, or key lacks listBuckets.`)
  }

  const hit = await findFileByName(sourceBucket, source, sourceBucketName)

  core.startGroup(
    `copy b2://${sourceBucketName}/${source} → b2://${destinationBucket.name}/${destination}`,
  )
  try {
    const recommendedPartSize = client.accountInfo.getRecommendedPartSize()
    const isLarge = hit.contentLength > recommendedPartSize
    const copyOptions = {
      sourceFileId: hit.fileId,
      fileName: destination,
      ...(sourceBucketName !== destinationBucket.name
        ? { destinationBucketId: destinationBucket.id }
        : {}),
      ...(inputs.sourceEncryption !== undefined
        ? { sourceServerSideEncryption: inputs.sourceEncryption }
        : {}),
      ...(inputs.encryption !== undefined
        ? { destinationServerSideEncryption: inputs.encryption }
        : {}),
    }

    const result = isLarge
      ? await destinationBucket.copyLargeFile({
          ...copyOptions,
          ...(signal !== undefined ? { signal } : {}),
        })
      : await destinationBucket.copyFile(copyOptions)

    core.info(`  copied → fileId=${result.fileId}, size=${result.contentLength}`)
    return {
      sourceBucket: sourceBucketName,
      sourceFileName: source,
      destinationBucket: destinationBucket.name,
      destinationFileName: destination,
      fileId: result.fileId,
      size: result.contentLength,
    }
  } finally {
    core.endGroup()
  }
}
