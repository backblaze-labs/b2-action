import * as core from '@actions/core'
import {
  applicationKeyId,
  type B2Client,
  Capability,
  type CreateKeyOptions,
} from '@backblaze-labs/b2-sdk'
import { B2Error } from '@backblaze-labs/b2-sdk/errors'
import type { ParsedInputs } from '../inputs.ts'

const SAFE_CREATE_KEY_CAPABILITIES = new Set<Capability>([
  Capability.ListFiles,
  Capability.ReadFiles,
  Capability.ShareFiles,
  Capability.WriteFiles,
  Capability.DeleteFiles,
  Capability.ReadFileLegalHolds,
  Capability.WriteFileLegalHolds,
  Capability.ReadFileRetentions,
  Capability.WriteFileRetentions,
])
const B2_LIST_KEYS_PAGE_SIZE_LIMIT = 1000

/** Application key metadata intentionally exposed by this action. */
export interface KeyMetadata {
  keyName: string
  applicationKeyId: string
  capabilities: readonly Capability[]
  expirationTimestamp: number | null
  bucketIds: readonly string[] | null
  namePrefix: string | null
  options: readonly string[]
}

/** Result of {@link createKeyCommand}. Includes the secret returned once by B2. */
export interface CreateKeyResult extends KeyMetadata {
  applicationKey: string
}

/** Result of {@link listKeysCommand}. */
export interface ListKeysResult {
  /** Application keys matching the account, capped by `max-results`. Secrets are never included. */
  keys: KeyMetadata[]
  /** True when more keys exist beyond `max-results`. */
  truncated: boolean
}

/** Result of {@link deleteKeyCommand}. */
export interface DeleteKeyResult extends KeyMetadata {
  /** True when the key was deleted; false for dry-run or already-absent no-ops. */
  deleted: boolean
  /** False when unsafe dry-run mode intentionally skipped key metadata lookup. */
  metadataVerified?: boolean
}

/**
 * Create a scoped B2 application key.
 *
 * `scope-bucket` is a bucket name because that is the workflow-friendly
 * identifier. The SDK/API require bucket IDs, so resolve the bucket first
 * and then pass the ID into `createKey`.
 */
export async function createKeyCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<CreateKeyResult> {
  if (inputs.keyName === undefined || inputs.keyName === '') {
    throw new Error("'key-name' input is required for 'create-key' action")
  }
  if (inputs.capabilities.length === 0) {
    throw new Error("'capabilities' input is required for 'create-key' action")
  }
  if (inputs.namePrefix !== undefined && inputs.scopeBucket === undefined) {
    throw new Error("'name-prefix' requires 'scope-bucket' for 'create-key' action")
  }
  validateCreateKeySafety(inputs)

  core.startGroup(`create application key ${inputs.keyName}`)
  try {
    const scopedBucket =
      inputs.scopeBucket !== undefined ? await client.getBucket(inputs.scopeBucket) : null
    if (inputs.scopeBucket !== undefined && scopedBucket === null) {
      throw new Error(
        `Bucket "${inputs.scopeBucket}" not found for 'scope-bucket', or the application key lacks listBuckets capability for it.`,
      )
    }

    const options: CreateKeyOptions = {
      capabilities: inputs.capabilities,
      keyName: inputs.keyName,
      ...(scopedBucket !== null ? { bucketIds: [scopedBucket.id] } : {}),
      ...(inputs.namePrefix !== undefined ? { namePrefix: inputs.namePrefix } : {}),
      ...(inputs.validDurationInSeconds !== undefined
        ? { validDurationInSeconds: inputs.validDurationInSeconds }
        : {}),
    }
    await assertNoExistingKeyWithName(client, inputs.keyName)
    const result = await client.createKey(options)
    core.info(`  created application key id ${result.applicationKeyId}`)
    core.info(
      '  B2 returns the application-key secret only once; if output writing or cleanup fails, revoke the logged application-key-id.',
    )
    return { ...keyMetadata(result), applicationKey: result.applicationKey }
  } finally {
    core.endGroup()
  }
}

/**
 * List application keys, capped by `max-results`.
 *
 * The SDK exposes one page at a time and reports a continuation key. Fetching
 * only the requested page mirrors the existing `list` verb's bounded behavior.
 */
export async function listKeysCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<ListKeysResult> {
  const maxResults = Math.min(inputs.maxResults, B2_LIST_KEYS_PAGE_SIZE_LIMIT)
  core.startGroup(`list application keys (max ${maxResults})`)
  try {
    const page = await client.listKeys({ pageSize: maxResults })
    core.info(`  ${page.keys.length} key(s) listed`)
    return {
      keys: page.keys.map(keyMetadata),
      truncated: page.nextApplicationKeyId !== null,
    }
  } finally {
    core.endGroup()
  }
}

/** Delete an application key by ID. */
export async function deleteKeyCommand(
  client: B2Client,
  inputs: ParsedInputs,
): Promise<DeleteKeyResult> {
  if (inputs.targetApplicationKeyId === undefined || inputs.targetApplicationKeyId === '') {
    throw new Error("'target-application-key-id' input is required for 'delete-key' action")
  }
  const targetApplicationKeyId = inputs.targetApplicationKeyId
  if (targetApplicationKeyId === inputs.applicationKeyId) {
    throw new Error('Refusing to delete the currently authorized application key')
  }
  if (
    !inputs.allowUnsafeKeyDelete &&
    inputs.keyName === undefined &&
    inputs.targetKeyNamePrefix === undefined
  ) {
    throw new Error(
      "'delete-key' requires 'key-name' or 'target-key-name-prefix' to validate intent; set 'allow-unsafe-key-delete: true' only for reviewed workflows",
    )
  }

  core.startGroup(`delete application key ${targetApplicationKeyId}`)
  try {
    const target = inputs.allowUnsafeKeyDelete
      ? null
      : await findKeyById(client, targetApplicationKeyId)
    if (target === null) {
      if (inputs.allowUnsafeKeyDelete && !inputs.dryRun) {
        try {
          const result = await client.deleteKey(applicationKeyId(targetApplicationKeyId))
          core.info(`  deleted ${result.applicationKeyId}`)
          return { ...keyMetadata(result), deleted: true }
        } catch (err) {
          if (!isMissingKeyError(err)) throw err
        }
      }
      if (inputs.allowUnsafeKeyDelete && inputs.dryRun) {
        core.info(
          `  dry-run: would delete ${targetApplicationKeyId}; existence and metadata were not validated because allow-unsafe-key-delete is set`,
        )
        return unverifiedDeleteResult(inputs)
      }
      core.info(`  application key ${targetApplicationKeyId} is already absent; no-op`)
      return missingDeleteResult(inputs)
    }

    validateDeleteTarget(target, inputs)
    if (inputs.dryRun) {
      core.info(`  dry-run: would delete ${target.applicationKeyId}`)
      return { ...target, deleted: false }
    }

    try {
      const result = await client.deleteKey(applicationKeyId(targetApplicationKeyId))
      core.info(`  deleted ${result.applicationKeyId}`)
      return { ...keyMetadata(result), deleted: true }
    } catch (err) {
      if (!isMissingKeyError(err)) throw err
      core.info(`  application key ${targetApplicationKeyId} is already absent; no-op`)
      return { ...target, deleted: false }
    }
  } finally {
    core.endGroup()
  }
}

function validateCreateKeySafety(inputs: ParsedInputs): void {
  if (inputs.scopeBucket === undefined && !inputs.allowAccountLevelKey) {
    throw new Error(
      "'scope-bucket' is required for 'create-key' unless 'allow-account-level-key: true' is set",
    )
  }
  if (inputs.validDurationInSeconds === undefined && !inputs.allowNonExpiringKey) {
    throw new Error(
      "'valid-duration' is required for 'create-key' unless 'allow-non-expiring-key: true' is set",
    )
  }
  const privileged = inputs.capabilities.filter((capability) => {
    return !SAFE_CREATE_KEY_CAPABILITIES.has(capability)
  })
  if (privileged.length > 0 && !inputs.allowPrivilegedCapabilities) {
    throw new Error(
      `Refusing privileged key capabilities without 'allow-privileged-capabilities: true': ${privileged.join(', ')}`,
    )
  }
}

async function assertNoExistingKeyWithName(client: B2Client, keyName: string): Promise<void> {
  let existing: KeyMetadata[]
  try {
    existing = await findKeysByName(client, keyName)
  } catch (err) {
    const detail = err instanceof Error ? ` ${err.message}` : ''
    throw new Error(
      `'create-key' requires listKeys permission to verify key-name uniqueness before minting a one-time secret.${detail}`,
    )
  }
  if (existing.length === 0) return

  const ids = existing.map((key) => key.applicationKeyId).join(', ')
  throw new Error(
    `Application key name "${keyName}" already exists (${ids}); refusing to create a duplicate. ` +
      'If a previous run crashed after B2 created the key, revoke the listed application-key-id because the one-time secret cannot be recovered.',
  )
}

async function findKeysByName(client: B2Client, keyName: string): Promise<KeyMetadata[]> {
  const matches: KeyMetadata[] = []
  for await (const key of client.paginateKeys({ pageSize: 1000 })) {
    if (key.keyName === keyName) matches.push(keyMetadata(key))
  }
  return matches
}

async function findKeyById(
  client: B2Client,
  targetApplicationKeyId: string,
): Promise<KeyMetadata | null> {
  try {
    for await (const key of client.paginateKeys({ pageSize: 1000 })) {
      if (key.applicationKeyId === targetApplicationKeyId) return keyMetadata(key)
    }
    return null
  } catch (err) {
    const detail = err instanceof Error ? ` ${err.message}` : ''
    throw new Error(
      `'delete-key' requires listKeys permission to validate the target key before deletion.${detail}`,
    )
  }
}

function validateDeleteTarget(target: KeyMetadata, inputs: ParsedInputs): void {
  if (inputs.keyName !== undefined && target.keyName !== inputs.keyName) {
    throw new Error(
      `Refusing to delete application key ${target.applicationKeyId}: expected key-name "${inputs.keyName}" but found "${target.keyName}"`,
    )
  }
  if (
    inputs.targetKeyNamePrefix !== undefined &&
    !target.keyName.startsWith(inputs.targetKeyNamePrefix)
  ) {
    throw new Error(
      `Refusing to delete application key ${target.applicationKeyId}: key-name "${target.keyName}" does not start with "${inputs.targetKeyNamePrefix}"`,
    )
  }
}

function missingDeleteResult(inputs: ParsedInputs): DeleteKeyResult {
  return {
    keyName: inputs.keyName ?? '(already absent)',
    applicationKeyId: inputs.targetApplicationKeyId ?? '',
    capabilities: [],
    expirationTimestamp: null,
    bucketIds: null,
    namePrefix: null,
    options: [],
    deleted: false,
  }
}

function unverifiedDeleteResult(inputs: ParsedInputs): DeleteKeyResult {
  return {
    keyName: inputs.keyName ?? '(not fetched)',
    applicationKeyId: inputs.targetApplicationKeyId ?? '',
    capabilities: [],
    expirationTimestamp: null,
    bucketIds: null,
    namePrefix: null,
    options: [],
    deleted: false,
    metadataVerified: false,
  }
}

function isMissingKeyError(err: unknown): boolean {
  return (
    err instanceof B2Error &&
    (err.code === 'not_found' || (err.code === 'bad_request' && /key not found/i.test(err.message)))
  )
}

function keyMetadata(key: {
  keyName: string
  applicationKeyId: string
  capabilities: readonly Capability[]
  expirationTimestamp: number | null
  bucketIds: readonly string[] | null
  namePrefix: string | null
  options: readonly string[]
}): KeyMetadata {
  return {
    keyName: key.keyName,
    applicationKeyId: key.applicationKeyId,
    capabilities: [...key.capabilities],
    expirationTimestamp: key.expirationTimestamp,
    bucketIds: key.bucketIds === null ? null : [...key.bucketIds],
    namePrefix: key.namePrefix,
    options: [...key.options],
  }
}
