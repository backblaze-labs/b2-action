import { lstat, mkdir, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import * as core from '@actions/core'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import type {
  CompareMode,
  KeepMode,
  SyncEvent,
  SynchronizerDownConfig,
  SynchronizerUpConfig,
} from '@backblaze-labs/b2-sdk/sync'
import { B2Folder, LocalFolder, synchronize } from '@backblaze-labs/b2-sdk/sync'
import { expandTilde, tryStat } from '../fs.ts'
import { type ParsedInputs, requireSource } from '../inputs.ts'

/**
 * Mutable counter bag fed by {@link processSyncEvent} as the action consumes
 * the SDK's `synchronize()` event stream. Exposed alongside the processor so
 * unit tests can drive each SyncEvent variant deterministically (notably the
 * `copy-start` / `copy-done` events that only fire in b2-to-b2 sync, which
 * the action's input surface doesn't currently expose).
 */
export interface SyncEventCounters {
  /** Count of files uploaded. */
  uploaded: number
  /** Count of files downloaded. */
  downloaded: number
  /** Count of files removed (delete-remote, delete-local, or hide). */
  deleted: number
  /** Count of files left unchanged. */
  skipped: number
  /** Count of per-file errors. */
  errors: number
  /** Total bytes transferred (upload + download). */
  bytesTransferred: number
}

/**
 * Apply one `SyncEvent` from the SDK's `synchronize()` stream to the running
 * counters and emit the corresponding log line. The action's `syncCommand`
 * calls this in a loop; the function is exported (and the {@link SyncEventCounters}
 * type with it) so tests can exercise every event variant independently,
 * including the `copy-*` events that require b2-to-b2 sync to fire from the
 * real engine.
 *
 * Informational lifecycle events (`upload-start`, `compare`, etc.) are
 * deliberate no-ops; listing them explicitly keeps the switch exhaustive
 * so TypeScript errors if the SDK adds a new variant.
 */
export function processSyncEvent(event: SyncEvent, counters: SyncEventCounters): void {
  switch (event.type) {
    case 'upload-done':
      counters.uploaded++
      counters.bytesTransferred += event.size
      core.info(`  ↑ ${event.path} (${event.size}B)`)
      return
    case 'download-done':
      counters.downloaded++
      counters.bytesTransferred += event.size
      core.info(`  ↓ ${event.path} (${event.size}B)`)
      return
    case 'delete-remote':
      counters.deleted++
      core.info(`  − ${event.path}`)
      return
    case 'delete-local':
      counters.deleted++
      core.info(`  − (local) ${event.path}`)
      return
    case 'hide':
      counters.deleted++
      core.info(`  ⌀ ${event.path} (hidden)`)
      return
    case 'skip':
      counters.skipped++
      return
    case 'error':
      counters.errors++
      core.warning(`  ! ${event.path}: ${event.message}`)
      return
    case 'upload-start':
    case 'compare':
    case 'download-start':
    case 'copy-start':
    case 'copy-done':
      return
  }
}

/**
 * Build a one-line summary of the first few sync errors for the dispatcher's
 * top-level failure message. Without this, a sync that fails on three files
 * surfaces only `Sync completed with 3 error(s)` to the user, who then has to
 * dig into the (possibly collapsed) per-file warnings or parse `summary-json`.
 * Including a sample makes the failure message itself diagnose-able.
 */
export function summarizeSyncErrors(events: SyncEvent[], limit = 3): string {
  const errors = events.filter(
    (e): e is Extract<SyncEvent, { type: 'error' }> => e.type === 'error',
  )
  if (errors.length === 0) return ''
  const head = errors
    .slice(0, limit)
    .map((e) => `${e.path}: ${e.message}`)
    .join('; ')
  const tail = errors.length > limit ? `; +${errors.length - limit} more` : ''
  return `${head}${tail}`
}

/** Result of {@link syncCommand}: per-event log plus aggregate counters. */
export interface SyncResult {
  /** Per-file events emitted by the SDK's `synchronize()` (upload-done, download-done, skip, delete-*, hide, error). */
  events: SyncEvent[]
  /** Resolved direction of this sync (after `auto` resolution). */
  direction: 'local-to-b2' | 'b2-to-local'
  /** Count of files uploaded. */
  uploaded: number
  /** Count of files downloaded. */
  downloaded: number
  /** Count of files deleted/hidden across both sides. */
  deleted: number
  /** Count of files left unchanged (already in sync). */
  skipped: number
  /** Count of per-file errors. */
  errors: number
  /** Total bytes transferred across both directions. */
  bytesTransferred: number
}

/**
 * Sync a local directory to / from a B2 bucket prefix.
 *
 * Direction is determined by the `direction` input (`up` = local → B2,
 * `down` = B2 → local). With `direction: auto` (the default) we infer:
 *   - if `source` is an existing local directory → `up`
 *   - otherwise → `down` (source is a B2 prefix, destination is local)
 *
 * The SDK's {@link synchronize} returns an `AsyncGenerator<SyncEvent>` which we
 * relay to the workflow log (per-file) and aggregate into a typed result.
 */
export async function syncCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const source = requireSource(inputs.source, 'sync', 'a local directory (up) or B2 prefix (down)')

  const direction = await resolveDirection(inputs.syncDirection, source)
  warnOnImplicitDownload(inputs.syncDirection, direction, source)
  const compareMode = inputs.compareMode
  const keepMode = inputs.keepMode
  const dryRun = inputs.dryRun

  const config = await buildConfig(bucket, source, inputs, direction, signal)

  core.startGroup(
    `sync ${direction === 'local-to-b2' ? source : `b2://${bucket.name}/${source}`} ` +
      `→ ${direction === 'local-to-b2' ? `b2://${bucket.name}/${inputs.destination ?? ''}` : (inputs.destination ?? '.')} ` +
      `(compare=${compareMode}, keep=${keepMode}${dryRun ? ', dry-run' : ''})`,
  )

  const events: SyncEvent[] = []
  const counters: SyncEventCounters = {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    skipped: 0,
    errors: 0,
    bytesTransferred: 0,
  }

  try {
    for await (const event of synchronize(config)) {
      events.push(event)
      processSyncEvent(event, counters)
    }
  } finally {
    core.endGroup()
  }

  const { uploaded, downloaded, deleted, skipped, errors, bytesTransferred } = counters

  core.info(
    `sync done [${direction}]: ${uploaded} uploaded, ${downloaded} downloaded, ${deleted} removed, ${skipped} unchanged, ${errors} errors`,
  )

  return {
    events,
    direction,
    uploaded,
    downloaded,
    deleted,
    skipped,
    errors,
    bytesTransferred,
  }
}

async function resolveDirection(
  requested: 'up' | 'down' | 'auto',
  source: string,
): Promise<'local-to-b2' | 'b2-to-local'> {
  if (requested === 'up') return 'local-to-b2'
  if (requested === 'down') return 'b2-to-local'
  // Auto-detection stats the local candidate, so expand `~` first: otherwise a
  // real home-directory source is never recognized and silently flips the sync
  // into a download.
  const localStat = await tryStat(expandTilde(source))
  return localStat?.isDirectory() ? 'local-to-b2' : 'b2-to-local'
}

/**
 * `direction: auto` infers `down` for anything that is not an existing local
 * directory, so a mistyped or not-yet-created local path silently becomes a
 * B2-to-local sync instead of failing. Warn when the source still looks like a
 * local path so the mistake is visible in the log.
 *
 * @internal
 */
export function warnOnImplicitDownload(
  requested: 'up' | 'down' | 'auto',
  resolved: 'local-to-b2' | 'b2-to-local',
  source: string,
): void {
  if (requested !== 'auto' || resolved !== 'b2-to-local') return
  if (!/^(?:~|\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(source)) return
  core.warning(
    `'source' ("${source}") looks like a local path but is not an existing directory, so ` +
      "'direction: auto' resolved this sync to B2 → local. Set 'direction: up' (or 'down') " +
      'explicitly to remove the ambiguity.',
  )
}

async function buildConfig(
  bucket: Bucket,
  source: string,
  inputs: ParsedInputs,
  direction: 'local-to-b2' | 'b2-to-local',
  signal?: AbortSignal,
): Promise<SynchronizerUpConfig | SynchronizerDownConfig> {
  const compareMode = inputs.compareMode
  const keepMode = inputs.keepMode
  const dryRun = inputs.dryRun
  const concurrency = inputs.concurrency
  const options = {
    compareMode,
    keepMode,
    concurrency,
    dryRun,
    ...(inputs.keepDays !== undefined ? { keepDays: inputs.keepDays } : {}),
    ...(signal !== undefined ? { signal } : {}),
  }

  if (direction === 'local-to-b2') {
    // Up: `source` is the local directory, `destination` is the B2 prefix.
    const localSource = expandTilde(source)
    const stats = await tryStat(localSource)
    if (!stats?.isDirectory()) {
      throw new Error(
        `'sync' up requires 'source' to be an existing local directory: ${localSource}`,
      )
    }
    const prefix = (inputs.destination ?? '').replace(/^\/+|\/+$/g, '')
    return {
      source: new LocalFolder(resolve(localSource)),
      dest: new B2Folder(bucket, prefix === '' ? '' : `${prefix}/`),
      bucket,
      prefix: prefix === '' ? '' : `${prefix}/`,
      options,
    }
  }

  // Down: `source` is the B2 prefix (opaque, never tilde-expanded),
  // `destination` is the local directory.
  const remotePrefix = source.replace(/^\/+|\/+$/g, '')
  const localDest = expandTilde(inputs.destination) ?? '.'
  const localRoot = await prepareLocalDestinationRoot(localDest)
  return {
    source: new B2Folder(bucket, remotePrefix === '' ? '' : `${remotePrefix}/`),
    dest: new LocalFolder(localRoot),
    bucket,
    options,
  }
}

async function prepareLocalDestinationRoot(localDest: string): Promise<string> {
  const resolved = resolve(localDest)
  await mkdir(resolved, { recursive: true })
  const stats = await lstat(resolved)
  if (stats.isSymbolicLink()) return resolved
  return realpath(resolved)
}

export type { CompareMode, KeepMode }
