import { B2Client } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  createBucketCommand,
  deleteBucketCommand,
  listBucketsCommand,
} from '../../src/commands/buckets.ts'
import { makeInputs } from '../_helpers.ts'
import { TEST_APPLICATION_KEY, TEST_APPLICATION_KEY_ID } from '../_parsed-inputs.ts'

describe('bucket administration commands', () => {
  let client: B2Client

  beforeEach(async () => {
    const sim = new B2Simulator()
    client = new B2Client({
      applicationKeyId: TEST_APPLICATION_KEY_ID,
      applicationKey: TEST_APPLICATION_KEY,
      transport: sim.transport(),
    })
    await client.authorize()
  })

  it('creates a bucket with the requested type and bucketInfo', async () => {
    const result = await createBucketCommand(
      client,
      makeInputs('create-bucket', {
        bucket: 'gh-action-bucket-create',
        bucketType: 'allPublic',
        bucketInfo: { Project: 'ci', owner: 'actions' },
      }),
    )

    expect(result).toMatchObject({
      bucketName: 'gh-action-bucket-create',
      bucketType: 'allPublic',
      bucketInfo: { Project: 'ci', owner: 'actions' },
    })
    expect(result.bucketId).toBeTruthy()

    const found = await client.getBucket('gh-action-bucket-create')
    expect(found?.info.bucketType).toBe('allPublic')
    expect(found?.info.bucketInfo).toEqual({ Project: 'ci', owner: 'actions' })
  })

  it('lists account buckets and supports an exact-name bucket filter', async () => {
    await client.createBucket({ bucketName: 'gh-action-bucket-a', bucketType: 'allPrivate' })
    await client.createBucket({ bucketName: 'gh-action-bucket-b', bucketType: 'allPublic' })

    const all = await listBucketsCommand(client, makeInputs('list-buckets', { bucket: '' }))
    expect(all.buckets.map((bucket) => bucket.bucketName).sort()).toEqual([
      'gh-action-bucket-a',
      'gh-action-bucket-b',
    ])

    const filtered = await listBucketsCommand(
      client,
      makeInputs('list-buckets', { bucket: 'gh-action-bucket-b' }),
    )
    expect(filtered.buckets.map((bucket) => bucket.bucketName)).toEqual(['gh-action-bucket-b'])
  })

  it('deletes an empty bucket by resolving its ID from the bucket name', async () => {
    const bucket = await client.createBucket({
      bucketName: 'gh-action-bucket-delete',
      bucketType: 'allPrivate',
    })

    const deleted = await deleteBucketCommand(
      client,
      makeInputs('delete-bucket', { bucket: bucket.name }),
    )

    expect(deleted).toMatchObject({
      bucketId: bucket.id,
      bucketName: bucket.name,
      bucketType: 'allPrivate',
    })
    await expect(client.getBucket(bucket.name)).resolves.toBeNull()
  })

  it('reports a clear error when delete-bucket cannot resolve the bucket', async () => {
    await expect(
      deleteBucketCommand(client, makeInputs('delete-bucket', { bucket: 'missing-bucket' })),
    ).rejects.toThrow(/Bucket "missing-bucket" not found/)
  })
})
