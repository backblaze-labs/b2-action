import { rm } from 'node:fs/promises'
import { type B2Client, Capability } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createKeyCommand, deleteKeyCommand, listKeysCommand } from '../../src/commands/keys.ts'
import { makeFixture, makeInputs, type TestFixture } from '../_helpers.ts'
import { TEST_APPLICATION_KEY_ID } from '../_parsed-inputs.ts'

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

  it('reports that scope-bucket lookup can fail from permissions', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', {
          keyName: 'missing-scope-bucket',
          capabilities: [Capability.ListFiles],
          scopeBucket: 'missing-bucket',
          validDurationInSeconds: 3600,
        }),
      ),
    ).rejects.toThrow(/listBuckets capability/)
  })

  it('requires a bucket scope when name-prefix is provided', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', {
          keyName: 'prefix-without-bucket',
          capabilities: [Capability.ListFiles],
          namePrefix: 'releases/',
          validDurationInSeconds: 3600,
        }),
      ),
    ).rejects.toThrow(/name-prefix.*scope-bucket/)
  })

  it('rejects account-level application keys unless explicitly allowed', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', {
          keyName: 'account-level-key',
          capabilities: [Capability.ListFiles],
          validDurationInSeconds: 3600,
        }),
      ),
    ).rejects.toThrow(/scope-bucket/)
  })

  it('rejects non-expiring application keys unless explicitly allowed', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', fx, {
          keyName: 'persistent-key',
          capabilities: [Capability.ListFiles],
          scopeBucket: fx.bucket.name,
        }),
      ),
    ).rejects.toThrow(/valid-duration/)
  })

  it('rejects privileged capabilities unless explicitly allowed', async () => {
    await expect(
      createKeyCommand(
        fx.client,
        makeInputs('create-key', fx, {
          keyName: 'privileged-key',
          capabilities: [Capability.ListFiles, Capability.WriteKeys],
          scopeBucket: fx.bucket.name,
          validDurationInSeconds: 3600,
        }),
      ),
    ).rejects.toThrow(/allow-privileged-capabilities/)
  })

  it('refuses to mint a duplicate key after an ambiguous retry', async () => {
    const inputs = makeInputs('create-key', fx, {
      keyName: 'retry-safe-key',
      capabilities: [Capability.ListFiles],
      scopeBucket: fx.bucket.name,
      validDurationInSeconds: 3600,
    })
    const created = await createKeyCommand(fx.client, inputs)

    await expect(createKeyCommand(fx.client, inputs)).rejects.toThrow(/already exists/)

    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))
    const matching = after.keys.filter((key) => key.keyName === 'retry-safe-key')
    expect(matching).toHaveLength(1)
    expect(matching[0]?.applicationKeyId).toBe(created.applicationKeyId)
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

  it('clamps list-keys page size to the B2 API maximum', async () => {
    const pageSizes: number[] = []
    const client = Object.create(fx.client) as B2Client
    client.listKeys = async (options) => {
      pageSizes.push(options?.pageSize ?? -1)
      return fx.client.listKeys(options)
    }

    await listKeysCommand(client, makeInputs('list-keys', { maxResults: 2500 }))

    expect(pageSizes).toEqual([1000])
  })

  it('deletes an application key by id', async () => {
    const created = await fx.client.createKey({
      keyName: 'delete-me',
      capabilities: [Capability.ListFiles],
    })

    const deleted = await deleteKeyCommand(
      fx.client,
      makeInputs('delete-key', {
        targetApplicationKeyId: created.applicationKeyId,
        keyName: created.keyName,
      }),
    )
    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))

    expect(deleted.applicationKeyId).toBe(created.applicationKeyId)
    expect(deleted.deleted).toBe(true)
    expect(after.keys.some((key) => key.applicationKeyId === created.applicationKeyId)).toBe(false)
  })

  it('treats an already-deleted key as an idempotent no-op on rerun', async () => {
    const created = await fx.client.createKey({
      keyName: 'delete-rerun',
      capabilities: [Capability.ListFiles],
    })
    const inputs = makeInputs('delete-key', {
      targetApplicationKeyId: created.applicationKeyId,
      keyName: created.keyName,
    })

    await expect(deleteKeyCommand(fx.client, inputs)).resolves.toMatchObject({ deleted: true })
    await expect(deleteKeyCommand(fx.client, inputs)).resolves.toMatchObject({
      applicationKeyId: created.applicationKeyId,
      deleted: false,
    })
  })

  it('does not fail a rerun after delete commits but the local response is lost', async () => {
    const created = await fx.client.createKey({
      keyName: 'lost-delete-response',
      capabilities: [Capability.ListFiles],
    })
    const inputs = makeInputs('delete-key', {
      targetApplicationKeyId: created.applicationKeyId,
      keyName: created.keyName,
    })
    const flakyClient = Object.create(fx.client) as B2Client
    flakyClient.deleteKey = async (id) => {
      await fx.client.deleteKey(id)
      throw new Error('lost local response')
    }

    await expect(deleteKeyCommand(flakyClient, inputs)).rejects.toThrow(/lost local response/)
    await expect(deleteKeyCommand(fx.client, inputs)).resolves.toMatchObject({
      applicationKeyId: created.applicationKeyId,
      deleted: false,
    })
  })

  it('rejects an arbitrary key id without a name or prefix allow-list', async () => {
    const created = await fx.client.createKey({
      keyName: 'unrelated-key',
      capabilities: [Capability.ListFiles],
    })

    await expect(
      deleteKeyCommand(
        fx.client,
        makeInputs('delete-key', { targetApplicationKeyId: created.applicationKeyId }),
      ),
    ).rejects.toThrow(/key-name.*target-key-name-prefix/)

    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))
    expect(after.keys.some((key) => key.applicationKeyId === created.applicationKeyId)).toBe(true)
  })

  it('rejects deleting the currently authorized application key id', async () => {
    await expect(
      deleteKeyCommand(
        fx.client,
        makeInputs('delete-key', {
          targetApplicationKeyId: TEST_APPLICATION_KEY_ID,
          keyName: 'current-key',
        }),
      ),
    ).rejects.toThrow(/currently authorized/)
  })

  it('honors dry-run for delete-key without deleting the target', async () => {
    const created = await fx.client.createKey({
      keyName: 'dry-run-delete',
      capabilities: [Capability.ListFiles],
    })

    const result = await deleteKeyCommand(
      fx.client,
      makeInputs('delete-key', {
        targetApplicationKeyId: created.applicationKeyId,
        keyName: created.keyName,
        dryRun: true,
      }),
    )
    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))

    expect(result.deleted).toBe(false)
    expect(after.keys.some((key) => key.applicationKeyId === created.applicationKeyId)).toBe(true)
  })

  it('does not report unsafe dry-run delete as already absent without lookup', async () => {
    const created = await fx.client.createKey({
      keyName: 'unsafe-dry-run-delete',
      capabilities: [Capability.ListFiles],
    })

    const result = await deleteKeyCommand(
      fx.client,
      makeInputs('delete-key', {
        targetApplicationKeyId: created.applicationKeyId,
        allowUnsafeKeyDelete: true,
        dryRun: true,
      }),
    )
    const after = await listKeysCommand(fx.client, makeInputs('list-keys', { maxResults: 100 }))

    expect(result).toMatchObject({
      applicationKeyId: created.applicationKeyId,
      keyName: '(not fetched)',
      deleted: false,
      metadataVerified: false,
    })
    expect(after.keys.some((key) => key.applicationKeyId === created.applicationKeyId)).toBe(true)
  })
})
