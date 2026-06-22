import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as core from '@actions/core'
import type { Bucket, SseCDownloadKey } from '@backblaze-labs/b2-sdk'
import { tryStat } from '../fs.ts'
import { type ParsedInputs, requireSource } from '../inputs.ts'
import { makeProgressListener } from '../progress.ts'

/** One entry in {@link DownloadResult.files}. */
export interface DownloadedFile {
  /** B2 file name (the key that was fetched). */
  fileName: string
  /** Absolute path on the runner where the body landed. */
  localPath: string
  /** Byte size of the downloaded body. */
  size: number
  /** Remote SHA-1, or `null` if the file was multipart-uploaded (B2 doesn't store a whole-file SHA-1 in that case). */
  contentSha1: string | null
}

/** Result of {@link downloadCommand}. */
export interface DownloadResult {
  /** One entry per downloaded file. Single-file modes return a one-element array. */
  files: DownloadedFile[]
  /** Total bytes transferred across all files. */
  bytesTransferred: number
}

/**
 * Download from B2 to the local runner.
 *
 * Modes:
 *   - If `source` ends with `/`, treat it as a prefix and download every file
 *     under it to the local directory at `destination` (defaults to `.`).
 *   - Otherwise download a single file. If `destination` ends with `/` or
 *     resolves to an existing directory, write into that directory using the
 *     basename of `source`. Else `destination` is the exact output file path.
 *     If unset, the file's basename is used in the current working directory.
 */
export async function downloadCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const source = requireSource(inputs.source, 'download', 'a B2 file name or prefix')
  const isPrefix = source.endsWith('/')

  const sseDownload = sseFromInputs(inputs)

  if (isPrefix) {
    return downloadPrefix(bucket, source, inputs.destination ?? '.', sseDownload, signal)
  }
  const out = await downloadOne(bucket, source, inputs.destination, sseDownload, signal)
  return { files: [out], bytesTransferred: out.size }
}

function sseFromInputs(inputs: ParsedInputs): SseCDownloadKey | undefined {
  const e = inputs.encryption
  if (e === undefined || e.mode !== 'SSE-C') return undefined
  return {
    algorithm: 'AES256',
    customerKey: e.customerKey,
    customerKeyMd5: e.customerKeyMd5,
  }
}

async function downloadPrefix(
  bucket: Bucket,
  prefix: string,
  destinationDir: string,
  sseDownload: SseCDownloadKey | undefined,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const destRoot = resolve(destinationDir)
  await mkdir(destRoot, { recursive: true })
  const caseInsensitivePaths = await isCaseInsensitiveDirectory(destRoot)

  const files: DownloadedFile[] = []
  const localPathOwners = new Map<string, string>()
  let total = 0
  let startFileName: string | undefined

  for (;;) {
    signal?.throwIfAborted()
    const page = await bucket.listFileNames({
      prefix,
      pageSize: 1000,
      ...(startFileName !== undefined ? { startFileName } : {}),
    })
    for (const f of page.files) {
      if (f.action !== 'upload') continue
      signal?.throwIfAborted()
      // `listFileNames({ prefix })` returns files matching `prefix` per the
      // SDK / B2 contract, so the slice is always safe. Empty `prefix`
      // leaves the name unchanged.
      const relName = f.fileName.slice(prefix.length)
      const localPath = await resolvePathUnderRoot(
        destRoot,
        safeRemotePathSegments(relName, f.fileName),
        f.fileName,
      )
      const collisionKey = localPathCollisionKey(localPath, caseInsensitivePaths)
      const existingFileName = localPathOwners.get(collisionKey)
      if (existingFileName !== undefined && existingFileName !== f.fileName) {
        throw new Error(
          `download path collision: B2 files "${existingFileName}" and "${f.fileName}" both map to "${localPath}"`,
        )
      }
      localPathOwners.set(collisionKey, f.fileName)
      core.startGroup(`download b2://${bucket.name}/${f.fileName} → ${localPath}`)
      try {
        const r = await downloadOne(bucket, f.fileName, localPath, sseDownload, signal)
        files.push(r)
        total += r.size
      } finally {
        core.endGroup()
      }
    }
    // SDK contract: `nextFileName` is `string | null` per `ListFileNamesResponse`.
    // The "not null" arm fires for prefixes with >1000 files (covered by
    // the real-pagination test in coverage-stress).
    if (page.nextFileName === null) break
    startFileName = page.nextFileName
  }

  return { files, bytesTransferred: total }
}

async function downloadOne(
  bucket: Bucket,
  fileName: string,
  destination: string | undefined,
  sseDownload: SseCDownloadKey | undefined,
  signal?: AbortSignal,
): Promise<DownloadedFile> {
  const localPath = await resolveLocalPath(fileName, destination)
  await mkdir(dirname(localPath), { recursive: true })

  const result = await bucket.download(fileName, {
    ...(sseDownload !== undefined ? { serverSideEncryption: sseDownload } : {}),
    ...(signal !== undefined ? { signal } : {}),
  })
  const size = result.headers.contentLength
  const sha1 = result.headers.contentSha1

  // Wrap the body in a byte-counting Transform that synthesizes ProgressEvents
  // for the shared progress listener. The SDK doesn't expose progress for
  // single-shot downloads; we compute it here from the known content-length.
  const onProgress = makeProgressListener(`download[${fileName}]`)
  const startedAt = Date.now()
  let bytesSeen = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      // The transform only runs when the body has bytes to push; for a zero-
      // length response Node's stream pipeline closes without invoking it,
      // so `size` is provably > 0 here.
      bytesSeen += chunk.length
      onProgress({
        bytesTransferred: bytesSeen,
        totalBytes: size,
        partsCompleted: 0,
        totalParts: null,
        elapsedMs: Date.now() - startedAt,
      })
      cb(null, chunk)
    },
  })

  const writeStream = createWriteStream(localPath)
  try {
    await pipeline(
      Readable.fromWeb(result.body as unknown as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      writeStream,
    )
  } catch (err) {
    // Partial download on disk is worse than no file (a subsequent run
    // could mistake it for a complete copy). Best-effort unlink and
    // re-throw; the outer dispatcher reports the original error.
    try {
      await unlink(localPath)
    } catch {
      // ignore: best-effort cleanup, the original error matters more
    }
    throw err
  }

  core.info(`  wrote ${size} bytes to ${localPath} (sha1=${sha1 ?? 'multipart'})`)

  return { fileName, localPath, size, contentSha1: sha1 }
}

/**
 * Resolve the local target path for a single B2 download.
 *
 * @internal
 */
export async function resolveLocalPath(
  fileName: string,
  destination: string | undefined,
): Promise<string> {
  if (destination === undefined || destination === '') {
    return resolve(safeRemotePathTail(fileName))
  }
  if (destination.endsWith('/') || destination.endsWith('\\')) {
    const destRoot = resolve(destination)
    await mkdir(destRoot, { recursive: true })
    return await resolvePathUnderRoot(destRoot, [safeRemotePathTail(fileName)], fileName)
  }
  const s = await tryStat(destination)
  if (s?.isDirectory()) {
    const destRoot = resolve(destination)
    return await resolvePathUnderRoot(destRoot, [safeRemotePathTail(fileName)], fileName)
  }
  return resolve(destination)
}

async function resolvePathUnderRoot(root: string, segments: string[], fileName: string) {
  const localPath = resolve(root, ...segments)
  const rel = relative(root, localPath)
  if (!isPathInsideRootRelative(rel)) {
    throw new Error(`download path for B2 file "${fileName}" escapes destination directory`)
  }
  await assertExistingAncestryInsideRoot(root, localPath, fileName)
  return localPath
}

function isPathInsideRootRelative(rel: string): boolean {
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function assertExistingAncestryInsideRoot(
  root: string,
  localPath: string,
  fileName: string,
): Promise<void> {
  const realRoot = await realpath(root)
  let candidate = dirname(localPath)

  for (;;) {
    try {
      const realCandidate = await realpath(candidate)
      const rel = relative(realRoot, realCandidate)
      if (isPathInsideRootRelative(rel)) return
      throw new Error(`download path for B2 file "${fileName}" escapes destination directory`)
    } catch (error) {
      if (!isFileNotFound(error)) throw error
      const parent = dirname(candidate)
      if (parent === candidate) throw error
      candidate = parent
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function isCaseInsensitiveDirectory(dir: string): Promise<boolean> {
  const marker = `.b2-action-case-check-${randomUUID()}`
  const lowerPath = resolve(dir, marker.toLowerCase())
  const upperPath = resolve(dir, marker.toUpperCase())

  await writeFile(lowerPath, '')
  try {
    try {
      return (await realpath(lowerPath)) === (await realpath(upperPath))
    } catch (error) {
      if (isFileNotFound(error)) return false
      throw error
    }
  } finally {
    try {
      await unlink(lowerPath)
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function localPathCollisionKey(localPath: string, caseInsensitivePaths: boolean): string {
  return caseInsensitivePaths ? localPath.toLowerCase() : localPath
}

function safeRemotePathSegments(fileName: string, displayName = fileName): string[] {
  const segments = fileName.split('/')
  for (const segment of segments) {
    validateRemotePathSegment(segment, displayName)
  }
  return segments
}

function safeRemotePathTail(fileName: string): string {
  const tail = fileName.split('/').at(-1) ?? ''
  validateRemotePathSegment(tail, fileName)
  return tail
}

function validateRemotePathSegment(segment: string, fileName: string): void {
  if (segment === '' || segment === '.' || segment === '..') {
    throw new Error(
      `download path for B2 file "${fileName}" cannot be safely mapped because it contains an empty, "." or ".." path segment`,
    )
  }
  for (const char of segment) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      throw new Error(
        `download path for B2 file "${fileName}" cannot be safely mapped because it contains a control character`,
      )
    }
  }

  // B2 keys are opaque, but prefix downloads must project `/`-separated
  // keys into the runner filesystem without path traversal or lossy rewrites.
  // POSIX runners can preserve characters such as `:`, `?`, trailing dots,
  // and Windows device names verbatim. Windows treats several of those as
  // separators or invalid/reserved filenames, so reject them there instead of
  // silently changing the on-disk name or risking two B2 keys overwriting one
  // local path.
  if (
    process.platform === 'win32' &&
    (/[<>:"|?*\\]/u.test(segment) ||
      /[. ]$/u.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))
  ) {
    throw new Error(
      `download path for B2 file "${fileName}" cannot be safely mapped on Windows because segment "${segment}" is reserved or contains a Windows path character`,
    )
  }
}
