import * as core from '@actions/core'
import type { B2Client, BucketInfo, BucketType } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'

export interface BucketCommandResult {
  bucketId: string
  bucketName: string
  bucketType: BucketType
  bucketInfo: Record<string, string>
  revision: number
}

export interface ListBucketsResult {
  buckets: BucketCommandResult[]
}

export async function createBucketCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<BucketCommandResult> {
  const bucketName = requireBucketName(inputs.bucket, 'create-bucket')
  const bucketType = inputs.bucketType
  if (bucketType === undefined) {
    throw new Error(`'bucket-type' input is required for 'create-bucket' action`)
  }

  core.startGroup(`create bucket b2://${bucketName} (${bucketType})`)
  try {
    const bucket = await client.createBucket({
      bucketName,
      bucketType,
      ...(Object.keys(inputs.bucketInfo).length > 0 ? { bucketInfo: inputs.bucketInfo } : {}),
    })
    core.info(`  created bucket ${bucket.name} (${bucket.id})`)
    return bucketResult(bucket.info)
  } finally {
    core.endGroup()
  }
}

export async function deleteBucketCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<BucketCommandResult> {
  const bucketName = requireBucketName(inputs.bucket, 'delete-bucket')

  core.startGroup(`delete bucket b2://${bucketName}`)
  try {
    const bucket = await client.getBucket(bucketName)
    if (bucket === null) {
      throw new Error(
        `Bucket "${bucketName}" not found, or the application key lacks listBuckets capability for it.`,
      )
    }
    const deleted = await client.deleteBucket(bucket.id)
    core.info(`  deleted bucket ${bucketName} (${deleted.bucketId})`)
    return bucketResult(deleted)
  } finally {
    core.endGroup()
  }
}

export async function listBucketsCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<ListBucketsResult> {
  const bucketName = inputs.bucket === '' ? undefined : inputs.bucket
  const label = bucketName === undefined ? 'list buckets' : `list buckets matching ${bucketName}`

  core.startGroup(label)
  try {
    const buckets = await client.listBuckets(bucketName === undefined ? undefined : { bucketName })
    core.info(`  ${buckets.length} bucket(s) listed`)
    return { buckets: buckets.map((bucket) => bucketResult(bucket.info)) }
  } finally {
    core.endGroup()
  }
}

function requireBucketName(bucket: string, action: 'create-bucket' | 'delete-bucket'): string {
  if (bucket === '') {
    throw new Error(`'bucket' input is required for '${action}' action`)
  }
  return bucket
}

function bucketResult(info: BucketInfo): BucketCommandResult {
  return {
    bucketId: info.bucketId,
    bucketName: info.bucketName,
    bucketType: info.bucketType,
    bucketInfo: info.bucketInfo,
    revision: info.revision,
  }
}
