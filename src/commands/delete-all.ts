import type { Bucket } from '@backblaze-labs/b2-sdk'

export interface DeleteAllDeleteEvent {
  type: 'delete'
  fileName: string
  fileId: string
}

export interface DeleteAllErrorEvent {
  type: 'error'
  fileName: string
  fileId: string
  message: string
}

export interface DeleteAllSkipEvent {
  type: 'skip'
  fileName: string
  fileId: string
}

export type DeleteAllEvent = DeleteAllDeleteEvent | DeleteAllErrorEvent | DeleteAllSkipEvent

export interface DeleteAllVersionsOptions {
  prefix?: string
  dryRun: boolean
  bypassGovernance: boolean
  signal?: AbortSignal
}

export async function* deleteAllVersions(
  bucket: Bucket,
  options: DeleteAllVersionsOptions,
): AsyncGenerator<DeleteAllEvent> {
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
      yield { type: 'delete', fileName: version.fileName, fileId: version.fileId }
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
