import * as core from '@actions/core'
import {
  type ApplicationKey,
  applicationKeyId,
  type B2Client,
  type CreateKeyOptions,
  type FullApplicationKey,
} from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'

/** Result of {@link createKeyCommand}. Includes the secret returned once by B2. */
export type CreateKeyResult = FullApplicationKey

/** Result of {@link listKeysCommand}. */
export interface ListKeysResult {
  /** Application keys matching the account, capped by `max-results`. Secrets are never included. */
  keys: ApplicationKey[]
  /** True when more keys exist beyond `max-results`. */
  truncated: boolean
}

/** Result of {@link deleteKeyCommand}. */
export type DeleteKeyResult = ApplicationKey

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

  core.startGroup(`create application key ${inputs.keyName}`)
  try {
    const scopedBucket =
      inputs.scopeBucket !== undefined ? await client.getBucket(inputs.scopeBucket) : null
    if (inputs.scopeBucket !== undefined && scopedBucket === null) {
      throw new Error(`Bucket "${inputs.scopeBucket}" not found for 'scope-bucket'`)
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
    const result = await client.createKey(options)
    core.info(`  created ${result.applicationKeyId}`)
    return result
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
  core.startGroup(`list application keys (max ${inputs.maxResults})`)
  try {
    const page = await client.listKeys({ pageSize: inputs.maxResults })
    core.info(`  ${page.keys.length} key(s) listed`)
    return {
      keys: [...page.keys],
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

  core.startGroup(`delete application key ${targetApplicationKeyId}`)
  try {
    const result = await client.deleteKey(applicationKeyId(targetApplicationKeyId))
    core.info(`  deleted ${result.applicationKeyId}`)
    return result
  } finally {
    core.endGroup()
  }
}
