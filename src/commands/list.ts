import * as core from '@actions/core'
import type { Bucket } from '@backblaze-labs/b2-sdk'
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

/** One virtual prefix returned when the list request uses a delimiter. */
export interface ListedPrefix {
  /** Common B2 key prefix, including the delimiter that ended the group. */
  prefix: string
}

/** Result of {@link listCommand}. */
export interface ListResult {
  /** Files matching the prefix, capped by `maxResults`. */
  files: ListedFile[]
  /** Virtual prefixes matching the prefix, capped together with files by `maxResults`. */
  prefixes: ListedPrefix[]
  /** True when more visible files or virtual prefixes exist beyond `maxResults`. */
  truncated: boolean
}

/**
 * List file names under a prefix.
 *
 * `source` is the prefix (use trailing `/` to list a "directory"). Empty
 * `source` lists everything the application key is allowed to see. Pagination
 * is followed transparently up to `max-results` entries. When `delimiter` is
 * set, B2 folder markers are returned separately as virtual prefixes.
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
  const prefixes: ListedPrefix[] = []
  let startFileName: string | undefined

  core.startGroup(`list b2://${bucket.name}/${prefix} (max ${maxResults})`)
  try {
    while (files.length + prefixes.length < maxResults) {
      const remaining = maxResults - files.length - prefixes.length
      const pageSize = Math.min(1000, remaining)
      const page = await bucket.listFileNames({
        prefix,
        pageSize,
        ...(inputs.delimiter !== undefined ? { delimiter: inputs.delimiter } : {}),
        ...(startFileName !== undefined ? { startFileName } : {}),
      })

      for (const f of page.files) {
        if (f.action === 'upload') {
          files.push({
            fileName: f.fileName,
            fileId: f.fileId,
            size: f.contentLength,
            contentSha1: f.contentSha1,
            uploadTimestamp: f.uploadTimestamp,
            contentType: f.contentType,
            fileInfo: f.fileInfo,
          })
        } else if (f.action === 'folder') {
          prefixes.push({ prefix: f.fileName })
        } else {
          continue
        }

        if (files.length + prefixes.length >= maxResults) {
          if (!page.nextFileName) return { files, prefixes, truncated: false }
          return {
            files,
            prefixes,
            truncated: await hasVisibleEntryAfter(
              bucket,
              prefix,
              inputs.delimiter,
              page.nextFileName,
            ),
          }
        }
      }

      if (!page.nextFileName) {
        return { files, prefixes, truncated: false }
      }
      startFileName = page.nextFileName
    }

    return { files, prefixes, truncated: true }
  } finally {
    const entryCount = files.length + prefixes.length
    core.info(`  ${entryCount} ${entryCount === 1 ? 'entry' : 'entries'} listed`)
    core.endGroup()
  }
}

async function hasVisibleEntryAfter(
  bucket: Bucket,
  prefix: string,
  delimiter: string | undefined,
  startFileName: string,
): Promise<boolean> {
  let cursor: string | undefined = startFileName

  while (cursor !== undefined) {
    const page = await bucket.listFileNames({
      prefix,
      pageSize: 1000,
      startFileName: cursor,
      ...(delimiter !== undefined ? { delimiter } : {}),
    })
    if (page.files.some((f) => f.action === 'upload' || f.action === 'folder')) return true
    cursor = page.nextFileName ?? undefined
  }

  return false
}
