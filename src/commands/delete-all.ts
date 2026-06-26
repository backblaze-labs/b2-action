import type {
  Bucket,
  DeleteAllDeleteEvent,
  DeleteAllErrorEvent,
  DeleteAllSkipEvent,
  FileAction,
} from '@backblaze-labs/b2-sdk'

export type DeleteAllVersionsDeleteEvent = DeleteAllDeleteEvent & {
  readonly action: FileAction
}

export type DeleteAllVersionsEvent =
  | DeleteAllVersionsDeleteEvent
  | DeleteAllErrorEvent
  | DeleteAllSkipEvent

export interface DeleteAllVersionsOptions {
  prefix?: string
  dryRun: boolean
  bypassGovernance: boolean
  signal?: AbortSignal
}

export async function* deleteAllVersions(
  bucket: Bucket,
  options: DeleteAllVersionsOptions,
): AsyncGenerator<DeleteAllVersionsEvent> {
  for await (const version of bucket.paginateFileVersions({
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })) {
    if (options.dryRun) {
      yield { type: 'skip', fileName: version.fileName, fileId: version.fileId }
      continue
    }

    try {
      if (options.bypassGovernance) {
        await bucket.deleteFileVersion(version.fileName, version.fileId, {
          bypassGovernance: true,
        })
      } else {
        await bucket.deleteFileVersion(version.fileName, version.fileId)
      }
      yield {
        type: 'delete',
        fileName: version.fileName,
        fileId: version.fileId,
        action: version.action,
      }
    } catch (error) {
      yield {
        type: 'error',
        fileName: version.fileName,
        fileId: version.fileId,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }
}
