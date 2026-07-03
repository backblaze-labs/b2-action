import * as core from '@actions/core'
import {
  type B2Client,
  type Bucket,
  type EncryptionSetting,
  type FileVersion,
  fileId,
} from '@backblaze-labs/b2-sdk'
import { findFileByName } from '../client.ts'
import { type ParsedInputs, requireSource } from '../inputs.ts'

const DEFAULT_COPY_CONTENT_TYPE = 'b2/x-auto'

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
      ? inputs.encryption?.mode === 'SSE-B2'
        ? await copyLargeFileWithSseB2Destination(client, destinationBucket, {
            sourceFile: hit,
            fileName: destination,
            destinationServerSideEncryption: inputs.encryption,
            concurrency: inputs.concurrency,
            ...(inputs.sourceEncryption !== undefined
              ? { sourceServerSideEncryption: inputs.sourceEncryption }
              : {}),
            ...(signal !== undefined ? { signal } : {}),
          })
        : await destinationBucket.copyLargeFile({
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

interface CopyLargeFileWithSseB2DestinationOptions {
  sourceFile: FileVersion
  fileName: string
  destinationServerSideEncryption: EncryptionSetting
  sourceServerSideEncryption?: EncryptionSetting
  concurrency: number
  signal?: AbortSignal
}

async function copyLargeFileWithSseB2Destination(
  client: B2Client,
  destinationBucket: Bucket,
  options: CopyLargeFileWithSseB2DestinationOptions,
): Promise<FileVersion> {
  const accountInfo = client.accountInfo
  const apiUrl = accountInfo.getApiUrl()
  const authToken = accountInfo.getAuthToken()
  const partSize = Math.max(
    accountInfo.getRecommendedPartSize(),
    accountInfo.getAbsoluteMinimumPartSize(),
  )
  const ranges = planCopyRanges(options.sourceFile.contentLength, partSize)

  options.signal?.throwIfAborted()
  const startResp = await client.raw.startLargeFile(apiUrl, authToken, {
    bucketId: destinationBucket.id,
    fileName: options.fileName,
    contentType: options.sourceFile.contentType ?? DEFAULT_COPY_CONTENT_TYPE,
    fileInfo: {},
    serverSideEncryption: options.destinationServerSideEncryption,
  })
  const largeFileId = startResp.fileId
  const partSha1s: string[] = new Array(ranges.length)

  try {
    let nextRangeIndex = 0
    const workerCount = Math.min(options.concurrency, ranges.length)
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        while (true) {
          const range = ranges[nextRangeIndex]
          nextRangeIndex += 1
          if (range === undefined) return

          options.signal?.throwIfAborted()
          const resp = await client.raw.copyPart(apiUrl, authToken, {
            sourceFileId: options.sourceFile.fileId,
            largeFileId: fileId(largeFileId),
            partNumber: range.partNumber,
            range: byteRangeHeader(range.start, range.end),
            ...(options.sourceServerSideEncryption !== undefined
              ? { sourceServerSideEncryption: options.sourceServerSideEncryption }
              : {}),
          })
          partSha1s[range.partNumber - 1] = resp.contentSha1
        }
      }),
    )

    options.signal?.throwIfAborted()
    return await client.raw.finishLargeFile(apiUrl, authToken, {
      fileId: largeFileId,
      partSha1Array: partSha1s,
    })
  } catch (error) {
    await cancelLargeFileBestEffort(client, largeFileId)
    throw error
  }
}

interface CopyRange {
  partNumber: number
  start: number
  end: number
}

function planCopyRanges(totalSize: number, partSize: number): CopyRange[] {
  const ranges: CopyRange[] = []
  for (let start = 0, partNumber = 1; start < totalSize; start += partSize, partNumber += 1) {
    const end = Math.min(start + partSize, totalSize) - 1
    ranges.push({ partNumber, start, end })
  }
  return ranges
}

function byteRangeHeader(start: number, end: number): string {
  return `bytes=${start}-${end}`
}

async function cancelLargeFileBestEffort(
  client: B2Client,
  largeFileId: Parameters<B2Client['raw']['cancelLargeFile']>[2]['fileId'],
): Promise<void> {
  try {
    await client.raw.cancelLargeFile(
      client.accountInfo.getApiUrl(),
      client.accountInfo.getAuthToken(),
      { fileId: largeFileId },
    )
  } catch {
    // Nothing useful to report without risking noisy logs for a cleanup path.
  }
}
