import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '@actions/core'
import { buildClient, getBucket } from './client.ts'
import { copyCommand } from './commands/copy.ts'
import { deleteCommand } from './commands/delete.ts'
import { downloadCommand } from './commands/download.ts'
import { headCommand } from './commands/head.ts'
import { hideCommand } from './commands/hide.ts'
import {
  B2_LIST_KEYS_PAGE_SIZE_LIMIT,
  createKeyCommand,
  type DeleteKeyResult,
  deleteKeyCommand,
  type KeyMetadata,
  listKeysCommand,
} from './commands/keys.ts'
import { listCommand } from './commands/list.ts'
import { type PresignedFile, presignCommand } from './commands/presign.ts'
import { purgeCommand } from './commands/purge.ts'
import { retentionCommand } from './commands/retention.ts'
import { summarizeSyncErrors, syncCommand } from './commands/sync.ts'
import { unhideCommand } from './commands/unhide.ts'
import { uploadCommand } from './commands/upload.ts'
import { verifyCommand } from './commands/verify.ts'
import { classifyActionError, formatActionDebugError } from './errors.ts'
import { collectInputSecretsForScrubbing, type ParsedInputs, parseInputs } from './inputs.ts'
import { setSummaryJsonOutput } from './outputs.ts'
import { STEP_SUMMARY_MAX_ROWS, type SummaryRow, writeStepSummary } from './summary.ts'

/**
 * Action entrypoint. Parses inputs, builds an authorized B2Client, dispatches
 * to the requested subcommand, and writes structured outputs back via
 * `core.setOutput`. Any thrown error is reported through `core.setFailed`
 * so the workflow step surfaces with a clear message and a non-zero exit.
 *
 * Each command path also publishes a `$GITHUB_STEP_SUMMARY` markdown block so
 * the run's summary page shows a per-file table without scrolling through the
 * live log.
 */
export async function run(): Promise<void> {
  // Wire workflow-cancellation signals (`SIGTERM` when the user cancels the
  // job or a sibling fails fast; `SIGINT` for Ctrl+C in local dev) to an
  // AbortController that long-running SDK operations subscribe to. Aborting
  // mid-upload lets the SDK cancel in-flight multipart sessions cleanly
  // rather than leaving them dangling for the user to pay storage on.
  const controller = new AbortController()
  const onSignal = (sig: NodeJS.Signals) => {
    core.warning(`Received ${sig}; cancelling in-flight B2 operations.`)
    controller.abort(new Error(`${sig} received`))
  }
  const onSigterm = () => onSignal('SIGTERM')
  const onSigint = () => onSignal('SIGINT')
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)
  const signal = controller.signal
  let action: ParsedInputs['action'] | undefined
  let dryRun: boolean | undefined
  const secretValues: string[] = []

  try {
    // These values are a defensive formatter scrub list for parser and
    // dispatcher-scope credentials and tokens. Command-level secrets such as
    // presigned URLs are masked at the command site with core.setSecret. Any
    // SDK free-form B2 messages that reach failure output are sanitized in
    // errors.ts.
    secretValues.push(...collectInputSecretsForScrubbing())
    const inputs = parseInputs()
    action = inputs.action
    dryRun = inputs.dryRun

    const authorized = await buildClient({
      applicationKeyId: inputs.applicationKeyId,
      applicationKey: inputs.applicationKey,
      bucket: inputs.bucket,
      ...(inputs.endpoint !== undefined ? { endpoint: inputs.endpoint } : {}),
    })
    const authToken = authorized.client.accountInfo.getAuthToken()
    if (authToken) registerSecretValue(secretValues, authToken)
    let resolvedBucket: Awaited<ReturnType<typeof getBucket>> | undefined
    const getActionBucket = async () => {
      resolvedBucket ??= await getBucket(authorized)
      return resolvedBucket
    }

    switch (inputs.action) {
      case 'upload': {
        const bucket = await getActionBucket()
        const result = await uploadCommand(bucket, inputs, signal)
        const first = result.files[0]
        if (first !== undefined) {
          core.setOutput('file-id', first.fileId)
          core.setOutput('file-name', first.fileName)
          if (first.contentSha1 !== null) core.setOutput('content-sha1', first.contentSha1)
        }
        core.setOutput('files-uploaded', String(result.files.length))
        setFileCountOutput(result.files.length)
        core.setOutput('bytes-transferred', String(result.bytesTransferred))
        core.info(`uploaded ${result.files.length} file(s), ${result.bytesTransferred} bytes`)
        await writeStepSummary({
          title: 'Backblaze B2: upload',
          totals: { files: result.files.length, bytes: result.bytesTransferred },
          ...stepSummaryRows(result.files, (f) => ({
            fileName: f.fileName,
            size: f.size,
            fileId: f.fileId,
            sha1: f.contentSha1,
            status: 'uploaded',
          })),
        })
        setSummaryJsonOutput(result.files)
        return
      }
      case 'download': {
        const bucket = await getActionBucket()
        const result = await downloadCommand(bucket, inputs, signal)
        const first = result.files[0]
        if (first !== undefined) {
          core.setOutput('file-name', first.fileName)
          if (first.contentSha1 !== null) core.setOutput('content-sha1', first.contentSha1)
        }
        core.setOutput('files-downloaded', String(result.files.length))
        setFileCountOutput(result.files.length)
        core.setOutput('bytes-transferred', String(result.bytesTransferred))
        core.info(`downloaded ${result.files.length} file(s), ${result.bytesTransferred} bytes`)
        await writeStepSummary({
          title: 'Backblaze B2: download',
          totals: { files: result.files.length, bytes: result.bytesTransferred },
          ...stepSummaryRows(result.files, (f) => ({
            fileName: f.fileName,
            size: f.size,
            sha1: f.contentSha1,
            status: 'downloaded',
          })),
        })
        setSummaryJsonOutput(result.files)
        return
      }
      case 'sync': {
        const bucket = await getActionBucket()
        const result = await syncCommand(bucket, inputs, signal)
        core.setOutput('files-uploaded', String(result.uploaded))
        core.setOutput('files-downloaded', String(result.downloaded))
        core.setOutput('files-deleted', String(result.deleted))
        setFileCountOutput(result.uploaded + result.downloaded + result.deleted + result.skipped)
        core.setOutput('bytes-transferred', String(result.bytesTransferred))
        setSummaryJsonOutput(result.events)
        if (result.errors > 0) {
          const sample = summarizeSyncErrors(result.events)
          throw new Error(`Sync completed with ${result.errors} error(s): ${sample}`)
        }
        const syncTitlePrefix = inputs.dryRun
          ? 'Backblaze B2: sync (dry-run)'
          : 'Backblaze B2: sync'
        await writeStepSummary({
          title: `${syncTitlePrefix} [${result.direction}]`,
          totals: {
            files: result.uploaded + result.downloaded + result.deleted,
            bytes: result.bytesTransferred,
          },
          rows: [
            {
              fileName: '(uploaded)',
              size: result.direction === 'local-to-b2' ? result.bytesTransferred : 0,
              status: String(result.uploaded),
            },
            {
              fileName: '(downloaded)',
              size: result.direction === 'b2-to-local' ? result.bytesTransferred : 0,
              status: String(result.downloaded),
            },
            { fileName: '(removed)', status: String(result.deleted) },
            { fileName: '(unchanged)', status: String(result.skipped) },
          ],
        })
        return
      }
      case 'copy': {
        const bucket = await getActionBucket()
        const result = await copyCommand(authorized.client, bucket, inputs, signal)
        core.setOutput('file-id', result.fileId)
        core.setOutput('file-name', result.destinationFileName)
        setFileCountOutput(1)
        core.setOutput('bytes-transferred', String(result.size))
        await writeStepSummary({
          title: 'Backblaze B2: copy',
          rows: [
            {
              fileName: `b2://${result.sourceBucket}/${result.sourceFileName} → b2://${result.destinationBucket}/${result.destinationFileName}`,
              size: result.size,
              fileId: result.fileId,
              status: 'copied (server-side)',
            },
          ],
        })
        setSummaryJsonOutput([result])
        return
      }
      case 'delete': {
        const bucket = await getActionBucket()
        const result = await deleteCommand(bucket, inputs, signal)
        await emitDeletionSummary('delete', result, inputs)
        return
      }
      case 'presign': {
        const bucket = await getActionBucket()
        const result = await presignCommand(authorized.client, bucket, inputs)
        const first = result.files[0]
        if (first !== undefined) {
          core.setOutput('presigned-url', first.url)
          core.setOutput('file-name', first.fileName)
        }
        core.setOutput('files-listed', String(result.files.length))
        setFileCountOutput(result.files.length)
        await writeStepSummary({
          title: `Backblaze B2: presign (${result.files.length})`,
          ...stepSummaryRows(result.files, (f) => ({
            fileName: f.fileName,
            status: `expires at ${new Date(f.expiresAt * 1000).toISOString()}`,
          })),
        })
        setSummaryJsonOutput(result.files, { item: presignSummaryItem })
        return
      }
      case 'list': {
        const bucket = await getActionBucket()
        const result = await listCommand(bucket, inputs)
        core.setOutput('files-listed', String(result.files.length))
        setFileCountOutput(result.files.length)
        if (result.truncated) {
          core.warning(
            `list result truncated at max-results=${inputs.maxResults}; raise it to see more`,
          )
        }
        await writeStepSummary({
          title: `Backblaze B2: list (${result.files.length}${result.truncated ? '+' : ''})`,
          totals: {
            files: result.files.length,
            bytes: result.files.reduce((s, f) => s + f.size, 0),
          },
          ...stepSummaryRows(result.files, (f) => ({
            fileName: f.fileName,
            size: f.size,
            fileId: f.fileId,
            sha1: f.contentSha1,
            status: f.contentType,
          })),
        })
        setSummaryJsonOutput(result.files)
        return
      }
      case 'hide': {
        const bucket = await getActionBucket()
        const result = await hideCommand(bucket, inputs)
        core.setOutput('file-id', result.fileId)
        core.setOutput('file-name', result.fileName)
        setFileCountOutput(1)
        await writeStepSummary({
          title: 'Backblaze B2: hide',
          rows: [{ fileName: result.fileName, fileId: result.fileId, status: 'hidden' }],
        })
        setSummaryJsonOutput([result])
        return
      }
      case 'unhide': {
        const bucket = await getActionBucket()
        const result = await unhideCommand(bucket, inputs)
        core.setOutput('file-name', result.fileName)
        if (result.removedMarkerFileId !== null) {
          core.setOutput('file-id', result.removedMarkerFileId)
        }
        setFileCountOutput(1)
        await writeStepSummary({
          title: 'Backblaze B2: unhide',
          rows: [
            {
              fileName: result.fileName,
              fileId: result.removedMarkerFileId ?? undefined,
              status: result.removedMarkerFileId === null ? 'no-op (not hidden)' : 'unhidden',
            },
          ],
        })
        setSummaryJsonOutput([result])
        return
      }
      case 'verify': {
        const bucket = await getActionBucket()
        const result = await verifyCommand(bucket, inputs)
        core.setOutput('verified', String(result.verified))
        core.setOutput('file-name', result.fileName)
        setFileCountOutput(1)
        if (result.remoteSha1 !== null) core.setOutput('remote-sha1', result.remoteSha1)
        if (result.localSha1 !== null) core.setOutput('local-sha1', result.localSha1)
        await writeStepSummary({
          title: result.verified ? 'Backblaze B2: verify ✓' : 'Backblaze B2: verify ✗',
          rows: [
            {
              fileName: result.fileName,
              size: result.remoteSize,
              sha1: result.remoteSha1,
              status: result.verified ? 'matches' : (result.reason ?? 'mismatch'),
            },
          ],
        })
        setSummaryJsonOutput([result])
        if (!result.verified) {
          throw new Error(result.reason ?? 'verify failed: SHA-1 mismatch')
        }
        return
      }
      case 'retention': {
        const bucket = await getActionBucket()
        const result = await retentionCommand(bucket, inputs)
        core.setOutput('file-id', result.fileId)
        core.setOutput('file-name', result.fileName)
        setFileCountOutput(1)
        await writeStepSummary({
          title: 'Backblaze B2: retention',
          rows: [
            {
              fileName: result.fileName,
              fileId: result.fileId,
              status: retentionStatusLine(result),
            },
          ],
        })
        setSummaryJsonOutput([result])
        return
      }
      case 'head': {
        const bucket = await getActionBucket()
        const result = await headCommand(bucket, inputs)
        core.setOutput('file-id', result.fileId)
        core.setOutput('file-name', result.fileName)
        if (result.contentSha1 !== null) core.setOutput('content-sha1', result.contentSha1)
        setFileCountOutput(1)
        core.setOutput('bytes-transferred', '0')
        await writeStepSummary({
          title: 'Backblaze B2: head',
          rows: [
            {
              fileName: result.fileName,
              size: result.size,
              fileId: result.fileId,
              sha1: result.contentSha1,
              status: result.contentType,
            },
          ],
        })
        setSummaryJsonOutput([result])
        return
      }
      case 'purge': {
        const bucket = await getActionBucket()
        const result = await purgeCommand(bucket, inputs, signal)
        await emitDeletionSummary('purge', result, inputs)
        return
      }
      case 'create-key': {
        const result = await createKeyCommand(authorized.client, inputs, signal)
        core.setOutput('application-key-id', result.applicationKeyId)
        core.setOutput('key-name', result.keyName)
        registerSecretValue(secretValues, result.applicationKey)
        core.setOutput('application-key', result.applicationKey)
        await writeStepSummary({
          title: 'Backblaze B2: create-key',
          rows: [applicationKeySummaryRow(result)],
        })
        setSummaryJsonOutput([result], { item: applicationKeySummaryItem })
        return
      }
      case 'list-keys': {
        const result = await listKeysCommand(authorized.client, inputs, signal)
        core.setOutput('keys-listed', String(result.keys.length))
        if (result.truncated) {
          const reason =
            inputs.maxResults >= B2_LIST_KEYS_PAGE_SIZE_LIMIT
              ? `B2 page-size limit=${B2_LIST_KEYS_PAGE_SIZE_LIMIT}; max-results values above ${B2_LIST_KEYS_PAGE_SIZE_LIMIT} have no effect`
              : `max-results=${inputs.maxResults}; raise it to see more`
          core.warning(`list-keys result truncated at ${reason}`)
        }
        await writeStepSummary({
          title: `Backblaze B2: list-keys (${result.keys.length}${result.truncated ? '+' : ''})`,
          ...stepSummaryRows(result.keys, applicationKeySummaryRow),
        })
        setSummaryJsonOutput(result.keys, { item: applicationKeySummaryItem })
        return
      }
      case 'delete-key': {
        const result = await deleteKeyCommand(authorized.client, inputs, signal)
        core.setOutput('application-key-id', result.applicationKeyId)
        core.setOutput('key-name', result.keyName)
        core.setOutput('key-deleted', String(result.deleted))
        await writeStepSummary({
          title: inputs.dryRun ? 'Backblaze B2: delete-key (dry-run)' : 'Backblaze B2: delete-key',
          rows: [applicationKeySummaryRow(result)],
        })
        setSummaryJsonOutput([result], { item: applicationKeySummaryItem })
        return
      }
    }
  } catch (err) {
    const failure = classifyActionError(err, {
      ...(action !== undefined ? { action } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
      secretValues,
    })
    core.debug(formatActionDebugError(err, { secretValues }))
    if (failure.retryable !== undefined) core.setOutput('retryable', String(failure.retryable))
    if (failure.retryAfter !== undefined) core.setOutput('retry-after', String(failure.retryAfter))
    core.setFailed(failure.message)
  } finally {
    process.off('SIGTERM', onSigterm)
    process.off('SIGINT', onSigint)
  }
}

/**
 * Checks whether this module is the process entrypoint.
 *
 * @param metaUrl - The current module URL from `import.meta.url`.
 * @param argv1 - The executable script path from `process.argv[1]`.
 * @returns `true` when the current module path matches the invoked script.
 */
export function isEntrypoint(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1))
  } catch {
    return false
  }
}

/**
 * Shared output-emission + step-summary for the two deletion verbs.
 * `delete` and `purge` returned-shape and dispatcher-side handling are
 * structurally identical (filter into actually-deleted vs would-delete,
 * set the same outputs, render the same capped row table); they differ only
 * in the verb label and the per-row status string.
 */
async function emitDeletionSummary(
  verb: 'delete' | 'purge',
  result: {
    files: { fileName: string; fileId: string; skipped: boolean }[]
    errors: number
  },
  inputs: ParsedInputs,
): Promise<void> {
  const actuallyDeleted = result.files.filter((f) => !f.skipped).length
  const wouldDelete = result.files.filter((f) => f.skipped).length
  core.setOutput('files-deleted', String(actuallyDeleted))
  setFileCountOutput(result.files.length)
  setSummaryJsonOutput(result.files)
  if (result.errors > 0) {
    const labels = { delete: 'Delete', purge: 'Purge' } as const
    throw new Error(`${labels[verb]} completed with ${result.errors} error(s)`)
  }
  const past = verb === 'delete' ? 'deleted' : 'purged'
  const future = verb === 'delete' ? 'would delete' : 'would purge'
  await writeStepSummary({
    title: inputs.dryRun ? `Backblaze B2: ${verb} (dry-run)` : `Backblaze B2: ${verb}`,
    totals: { files: actuallyDeleted + wouldDelete, bytes: 0 },
    ...stepSummaryRows(result.files, (f) => ({
      fileName: f.fileName,
      fileId: f.fileId,
      status: f.skipped ? future : past,
    })),
  })
}

function stepSummaryRows<T>(
  items: readonly T[],
  row: (item: T) => SummaryRow,
): { rows: SummaryRow[]; totalRows?: number } {
  // Pre-slice here to avoid mapping very large result sets; writeStepSummary
  // keeps its own defensive cap for direct callers.
  const rows = items.slice(0, STEP_SUMMARY_MAX_ROWS).map(row)
  return rows.length < items.length ? { rows, totalRows: items.length } : { rows }
}

function presignSummaryItem(file: PresignedFile): Pick<PresignedFile, 'fileName' | 'expiresAt'> {
  return { fileName: file.fileName, expiresAt: file.expiresAt }
}

function applicationKeySummaryItem(key: KeyMetadata | DeleteKeyResult) {
  const item = {
    keyName: key.keyName,
    applicationKeyId: key.applicationKeyId,
    capabilities: key.capabilities,
    expirationTimestamp: key.expirationTimestamp,
    bucketIds: key.bucketIds,
    namePrefix: key.namePrefix,
    options: key.options,
  }
  return 'deleted' in key
    ? {
        ...item,
        deleted: key.deleted,
        ...(key.metadataVerified === false ? { metadataVerified: false } : {}),
      }
    : item
}

function applicationKeySummaryRow(key: KeyMetadata | DeleteKeyResult): SummaryRow {
  return {
    fileName: `keyName=${key.keyName}`,
    fileId: `applicationKeyId=${key.applicationKeyId}`,
    status: applicationKeyStatusLine(key),
  }
}

function applicationKeyStatusLine(key: KeyMetadata | DeleteKeyResult): string {
  if ('deleted' in key && key.metadataVerified === false) {
    return `metadata=not-fetched ${key.deleted ? 'deleted=true' : 'deleted=false'}`
  }
  const parts = [
    `capabilities=${key.capabilities.join(',') || '-'}`,
    `buckets=${key.bucketIds === null ? 'all' : key.bucketIds.join(',')}`,
  ]
  if (key.namePrefix !== null) parts.push(`prefix=${key.namePrefix}`)
  parts.push(
    `expires=${
      key.expirationTimestamp === null ? 'never' : new Date(key.expirationTimestamp).toISOString()
    }`,
  )
  if ('deleted' in key) parts.push(key.deleted ? 'deleted=true' : 'deleted=false')
  return parts.join(' ')
}

function setFileCountOutput(count: number): void {
  core.setOutput('file-count', String(count))
}

function registerSecretValue(secretValues: string[], value: string): void {
  const trimmed = value.trim()
  for (const secret of [value, trimmed]) {
    if (secret === '' || secretValues.includes(secret)) continue
    core.setSecret(secret)
    secretValues.push(secret)
  }
}

function retentionStatusLine(result: {
  appliedMode: 'compliance' | 'governance' | 'none' | undefined
  retainUntilTimestamp: number | null | undefined
  appliedLegalHold: 'on' | 'off' | undefined
}): string {
  const parts: string[] = [`mode=${result.appliedMode ?? '-'}`]
  if (result.retainUntilTimestamp != null) {
    parts.push(`until=${new Date(result.retainUntilTimestamp).toISOString()}`)
  }
  if (result.appliedLegalHold !== undefined) {
    parts.push(`legal-hold=${result.appliedLegalHold}`)
  }
  return parts.join(' ')
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  void run()
}
