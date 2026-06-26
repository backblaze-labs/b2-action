import * as core from '@actions/core'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import type { ParsedInputs } from '../inputs.ts'
import { deleteAllVersions } from './delete-all.ts'

/** One entry in {@link PurgeResult.files}. */
export interface PurgedFile {
  /** B2 file name (the key). */
  fileName: string
  /** B2 file ID of the version that was purged. */
  fileId: string
  /** Which kind of version this entry refers to: an `upload` (real data), a `hide` marker, or a `skip` (dry-run). */
  action: 'upload' | 'hide' | 'skip'
  /** True for dry-run previews; the version was not actually purged. */
  skipped: boolean
}

/** Result of {@link purgeCommand}. */
export interface PurgeResult {
  /** One entry per matched version (live, prior, and hide markers). */
  files: PurgedFile[]
  /** Count of individual-version purge failures. */
  errors: number
}

/**
 * Permanently delete every file version (including hide markers and historic
 * uploads) under a prefix. Differs from `delete` in that `delete`'s
 * implementation streams over `listFileVersions` and removes all versions,
 * but `purge` makes the wipe-the-prefix intent explicit and warns loudly.
 *
 * If `source` is empty or `/`, this purges the **entire bucket** only when
 * `allow-bucket-purge: true` is also set. Default behavior is to require a
 * scoped prefix so an omitted source cannot become a bucket-wide wipe.
 *
 * Supports `dry-run` to preview what would be deleted.
 */
export async function purgeCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<PurgeResult> {
  const bucketWide = inputs.source === undefined || inputs.source === '' || inputs.source === '/'
  if (bucketWide && !inputs.allowBucketPurge) {
    throw new Error(
      "'allow-bucket-purge' must be true for whole-bucket purge (set 'source' to a prefix for scoped purge)",
    )
  }
  const source = inputs.source ?? ''
  const prefix = bucketWide ? '' : source.endsWith('/') ? source : `${source}/`
  const dryRun = inputs.dryRun

  if (prefix === '' && !dryRun) {
    core.warning(
      `purge will permanently delete EVERY version in bucket "${bucket.name}". Continuing because allow-bucket-purge is true.`,
    )
  }

  const files: PurgedFile[] = []
  let errors = 0

  core.startGroup(`${dryRun ? 'dry-run' : 'purge'} b2://${bucket.name}/${prefix} (all versions)`)
  try {
    const opts = {
      ...(prefix !== '' ? { prefix } : {}),
      dryRun,
      bypassGovernance: inputs.bypassGovernance,
      ...(signal !== undefined ? { signal } : {}),
    }
    for await (const event of deleteAllVersions(bucket, opts)) {
      if (event.type === 'delete') {
        files.push({
          fileName: event.fileName,
          fileId: event.fileId,
          action: 'upload',
          skipped: false,
        })
        core.info(`  purged ${event.fileName} (${event.fileId})`)
      } else if (event.type === 'skip') {
        files.push({
          fileName: event.fileName,
          fileId: event.fileId,
          action: 'skip',
          skipped: true,
        })
        core.info(`  would purge ${event.fileName} (${event.fileId})`)
      } else {
        errors++
        core.warning(`  failed to purge ${event.fileName}: ${event.message}`)
      }
    }
  } finally {
    core.endGroup()
  }

  return { files, errors }
}
