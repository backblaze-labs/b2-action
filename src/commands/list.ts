import * as core from '@actions/core'
import type { Bucket, ListFileNamesResponse } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'

/** One entry in {@link ListResult.files}. Mirrors the SDK's per-version metadata. */
export interface ListedFile {
  /** B2 file name (the key). */
  fileName: string
  /** B2 file ID. */
  fileId: string
  /** Byte size of the file. */
  size: number
  /** Whole-file SHA-1, or `null` for multipart uploads. */
  contentSha1: string | null
  /** Server-side upload timestamp in milliseconds since the epoch. */
  uploadTimestamp: number
  /** Content-Type the file was uploaded with. */
  contentType: string
  /** Custom `X-Bz-Info-*` headers from upload time. */
  fileInfo: Record<string, string>
}

/** Result of {@link listCommand}. */
export interface ListResult {
  /** Files matching the prefix, capped by `maxResults`. */
  files: ListedFile[]
  /** True when more visible upload files exist beyond `maxResults`. Use to detect pagination. */
  truncated: boolean
}

/**
 * List file names under a prefix.
 *
 * `source` is the prefix (use trailing `/` to list a "directory"). Empty
 * `source` lists everything the application key is allowed to see. Pagination
 * is followed transparently up to `max-results` matches.
 *
 * Useful for "decide what to do next" workflow steps:
 *   - inventory before a delete
 *   - find the most recent release artifact to promote
 *   - emit a JSON manifest as a build output
 */
export async function listCommand(bucket: Bucket, inputs: ParsedInputs): Promise<ListResult> {
  const prefix = inputs.source ?? ''
  const maxResults = inputs.maxResults
  const files: ListedFile[] = []
  let startFileName: string | undefined

  core.startGroup(`list b2://${bucket.name}/${prefix} (max ${maxResults})`)
  try {
    while (files.length < maxResults) {
      const remaining = maxResults - files.length
      const pageSize = Math.min(1000, remaining)
      const page = await bucket.listFileNames({
        prefix,
        pageSize,
        ...(startFileName !== undefined ? { startFileName } : {}),
      })

      for (const f of page.files) {
        if (f.action !== 'upload') continue
        files.push({
          fileName: f.fileName,
          fileId: f.fileId,
          size: f.contentLength,
          contentSha1: f.contentSha1,
          uploadTimestamp: f.uploadTimestamp,
          contentType: f.contentType,
          fileInfo: f.fileInfo,
        })
        if (files.length >= maxResults) {
          if (!page.nextFileName) return { files, truncated: false }
          return {
            files,
            truncated: await hasVisibleUploadAfter(bucket, prefix, page.nextFileName),
          }
        }
      }

      if (!page.nextFileName) {
        return { files, truncated: false }
      }
      startFileName = page.nextFileName
    }

    return { files, truncated: true }
  } finally {
    core.info(`  ${files.length} file(s) listed`)
    core.endGroup()
  }
}

async function hasVisibleUploadAfter(
  bucket: Bucket,
  prefix: string,
  startFileName: string,
): Promise<boolean> {
  let cursor: string | undefined = startFileName

  while (cursor !== undefined) {
    const page: ListFileNamesResponse = await bucket.listFileNames({
      prefix,
      pageSize: 1000,
      startFileName: cursor,
    })
    if (page.files.some((f) => f.action === 'upload')) return true
    cursor = page.nextFileName ?? undefined
  }

  return false
}
