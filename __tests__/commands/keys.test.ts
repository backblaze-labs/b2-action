import { rm } from 'node:fs/promises'
import { Capability } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyCommand, deleteKeyCommand, listKeysCommand } from '../../src/commands/keys.ts'
import { makeFixture, makeInputs, type TestFixture } from '../_helpers.ts'

describe('application key commands', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('key-command-bucket')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('creates a bucket- and prefix-scoped application key with a one-time secret', async () => {
    const before = Date.now()

    const result = await createKeyCommand(
      fx.client,
      makeInputs('create-key', fx, {
        keyName: 'ci-scoped-key',
        capabilities: [Capability.ListFiles, Capability.ReadFiles, Capability.WriteFiles],
        scopeBucket: fx.bucket.name,
        namePrefix: 'releases/',
        validDurationInSeconds: 3600,
      }),
    )

    expect(result.keyName).toBe('ci-scoped-key')
    expect(result.applicationKeyId).toBeTruthy()
    expect(result.applicationKey).toBeTruthy()
    expect(result.capabilities).toEqual([
      Capability.ListFiles,
      Capability.ReadFiles,
      Capability.WriteFiles,
    ])
    expect(result.bucketIds).toEqual([fx.bucket.id])
    expect(result.namePrefix).toBe('releases/')
    expect(result.expirationTimestamp).toBeGreaterThanOrEqual(before + 3600 * 1000)
  })

  it('requires a bucket scope when name-prefix is provided', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', {
          keyName: 'prefix-without-bucket',
          capabilities: [Capability.ListFiles],
          namePrefix: 'releases/',
        }),
      ),
    ).rejects.toThrow(/name-prefix.*scope-bucket/)
  })

  it('lists application keys without exposing their secrets', async () => {
    const created = await fx.client.createKey({
      keyName: 'listed-key',
      capabilities: [Capability.ListFiles],
    })

    const result = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))

    const listed = result.keys.find((key) => key.applicationKeyId === created.applicationKeyId)
    expect(listed).toMatchObject({
      keyName: 'listed-key',
      capabilities: [Capability.ListFiles],
      bucketIds: null,
      namePrefix: null,
    })
    expect(listed).not.toHaveProperty('applicationKey')
    expect(result.truncated).toBe(false)
  })

  it('reports truncation when more keys exist beyond max-results', async () => {
    await fx.client.createKey({ keyName: 'first-page-key', capabilities: [Capability.ListFiles] })
    await fx.client.createKey({ keyName: 'second-page-key', capabilities: [Capability.ReadFiles] })

    const result = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 1 }))

    expect(result.keys).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('deletes an application key by id', async () => {
    const created = await fx.client.createKey({
      keyName: 'delete-me',
      capabilities: [Capability.ListFiles],
    })

    const deleted = await deleteKeyCommand(
      fx.client,
      makeInputs('delete-key', { targetApplicationKeyId: created.applicationKeyId }),
    )
    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))

    expect(deleted.applicationKeyId).toBe(created.applicationKeyId)
    expect(after.keys.some((key) => key.applicationKeyId === created.applicationKeyId)).toBe(false)
  })
})
