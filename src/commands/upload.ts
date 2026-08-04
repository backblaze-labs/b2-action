import { createReadStream } from 'node:fs'
import { basename, isAbsolute, posix, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import type { Bucket } from '@backblaze-labs/b2-sdk'
import { StreamSource } from '@backblaze-labs/b2-sdk/streams'
import { expandTilde, tryStat } from '../fs.ts'
import {
  type ParsedInputs,
  requireSource,
  uploadFileInfoTotalMaxBytes,
  validateFileInfo,
} from '../inputs.ts'
import { makeProgressListener } from '../progress.ts'

/** One entry in {@link UploadResult.files}. */
export interface UploadedFile {
  /** Absolute path on the runner that was uploaded. */
  localPath: string
  /** B2 file name (the key) the upload landed under. */
  fileName: string
  /** B2 file ID assigned by the server. */
  fileId: string
  /** Byte size of the upload. */
  size: number
  /** Whole-file SHA-1, or `null` when the file was multipart-uploaded. */
  contentSha1: string | null
  /**
   * B2 fileInfo metadata for the uploaded object. This is the SDK-returned
   * metadata when available; otherwise it falls back to the canonical metadata
   * submitted in the upload request.
   */
  fileInfo: Record<string, string>
}

/** Result of {@link uploadCommand}. */
export interface UploadResult {
  /** One entry per uploaded file. Single-file mode returns a one-element array. */
  files: UploadedFile[]
  /** Total bytes uploaded across all files. */
  bytesTransferred: number
}

/**
 * Upload one or more files to B2.
 *
 * Mode selection:
 *   - If `source` is a plain file path (no glob metacharacters and the path
 *     exists as a regular file), upload that single file. The B2 file name is
 *     `destination` if set; otherwise `basename(source)`.
 *   - Otherwise treat `source` (plus any `include` patterns) as glob(s). Each
 *     matched file is uploaded preserving its path relative to the glob root,
 *     prefixed by `destination` (default empty).
 *
 * Large files are streamed (StreamSource over a fs ReadStream-as-Web-Stream)
 * so we don't buffer the whole payload in RAM. The SDK's `Bucket.upload`
 * routes to multipart automatically when size exceeds the recommended part
 * size and parallelizes parts up to `concurrency`.
 */
export async function uploadCommand(
  bucket: Bucket,
  inputs: ParsedInputs,
  signal?: AbortSignal,
): Promise<UploadResult> {
  const source = requireSource(inputs.source, 'upload')

  const { files, isSingleExplicitFile } = await resolveFiles(source, inputs.include, inputs.exclude)
  if (files.length === 0) {
    if (inputs.failOnEmpty) {
      throw new Error(`No files matched: ${source}`)
    }
    core.warning(`No files matched: ${source}`)
    return { files: [], bytesTransferred: 0 }
  }

  const fileConcurrency = isSingleExplicitFile ? 1 : inputs.concurrency
  // Multi-file uploads spend the concurrency budget across files and keep each
  // file's multipart upload sequential so total in-flight B2 requests remain
  // bounded by the user-supplied `concurrency` value.
  const partConcurrency = isSingleExplicitFile || files.length === 1 ? inputs.concurrency : 1

  const uploadPlans = await mapWithConcurrency(files, fileConcurrency, async (f) => {
    signal?.throwIfAborted()
    return await prepareUploadPlan(f, inputs, isSingleExplicitFile)
  })
  assertUniqueUploadFileNames(uploadPlans)

  const uploaded = await mapWithConcurrency(uploadPlans, fileConcurrency, async (plan) => {
    signal?.throwIfAborted()
    const uploadLabel = `upload ${plan.localPath} → b2://${bucket.name}/${plan.fileName}`
    const groupedLog = uploadPlans.length === 1 || fileConcurrency === 1
    if (groupedLog) {
      core.startGroup(uploadLabel)
    } else {
      core.info(uploadLabel)
    }
    try {
      return await uploadOne(bucket, plan, inputs, partConcurrency, groupedLog, signal)
    } finally {
      if (groupedLog) core.endGroup()
    }
  })
  const totalBytes = uploaded.reduce((sum, file) => sum + file.size, 0)

  return { files: uploaded, bytesTransferred: totalBytes }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(items.length)
  let next = 0
  let firstError: unknown
  let failed = false

  async function worker(): Promise<void> {
    while (true) {
      if (failed) return
      const index = next++
      if (index >= items.length) return
      try {
        results[index] = await mapper(items[index] as T)
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
        }
        return
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  if (failed) throw firstError
  return results
}

interface ResolvedFiles {
  files: ResolvedFile[]
  isSingleExplicitFile: boolean
}

/**
 * Local file resolved from an upload source.
 *
 * @internal
 */
export interface ResolvedFile {
  localPath: string
  /** Path relative to the glob root, used when computing the B2 key. */
  fileName: string
  /** Byte size captured while resolving the upload source. */
  size: number
  /** Modification time captured while resolving the upload source. */
  mtimeMs: number
}

interface UploadPlan {
  localPath: string
  fileName: string
  size: number
  lastModifiedMillis: number | undefined
  fileInfo: Record<string, string>
}

/** Duplicate B2 key detected before upload starts. */
export interface UploadFileNameCollision {
  /** Final B2 file name that more than one local path would write. */
  fileName: string
  /** Local files that would collide on {@link UploadFileNameCollision.fileName}. */
  localPaths: string[]
}

/** Local file and projected B2 key used for duplicate upload-key checks. */
export interface UploadFileNameOwner {
  /** Absolute or resolved local file path. */
  localPath: string
  /** Final B2 file name after destination remapping. */
  fileName: string
}

async function resolveFiles(
  rawSource: string,
  rawInclude: string[],
  rawExclude: string[],
): Promise<ResolvedFiles> {
  // `source`, `include` and `exclude` are all local paths or globs, so a
  // leading `~` is the user's home directory, not a directory named `~`.
  const source = expandTilde(rawSource)
  const include = rawInclude.map((pattern) => expandTilde(pattern))
  const exclude = rawExclude.map((pattern) => expandTilde(pattern))
  const explicitFile = await tryStat(source)
  const looksLikeGlob = /[*?[\]]/.test(source)

  if (explicitFile?.isFile() && !looksLikeGlob && include.length === 0) {
    return {
      files: [
        {
          localPath: resolve(source),
          fileName: basename(source),
          size: explicitFile.size,
          mtimeMs: explicitFile.mtimeMs,
        },
      ],
      isSingleExplicitFile: true,
    }
  }

  const patterns: string[] = []
  if (explicitFile?.isDirectory()) {
    patterns.push(`${resolve(source)}/**`)
  } else {
    patterns.push(source)
  }
  for (const p of include) patterns.push(p)
  for (const p of exclude) patterns.push(`!${p}`)

  const globber = await glob.create(patterns.join('\n'), {
    followSymbolicLinks: false,
    matchDirectories: false,
  })
  const matches = await globber.glob()
  // `process.cwd()` stays first so in-workspace globs keep their historical
  // keys. A match outside every root used to produce `relative()` output full
  // of `..` segments, yielding B2 keys such as
  // `artifacts/../../../tmp/x/a.bin` that this action's own prefix download
  // then refuses to map back onto disk.
  const roots = explicitFile?.isDirectory()
    ? [resolve(source)]
    : [process.cwd(), ...globber.getSearchPaths()]

  const out: ResolvedFile[] = []
  for (const m of matches) {
    const s = await tryStat(m)
    // Filesystem boundary: skip entries that aren't readable files (broken
    // symlinks, races where a file is unlinked between glob and stat, etc.).
    if (!s?.isFile()) continue
    const rel = relativeUploadKey(roots, m)
    out.push({ localPath: m, fileName: rel, size: s.size, mtimeMs: s.mtimeMs })
  }
  out.sort(compareResolvedFiles)
  return { files: out, isSingleExplicitFile: false }
}

/**
 * Project a matched local path onto its B2 key, relative to the first root
 * that actually contains it. Falls back to the basename so a match outside
 * every candidate root still produces a mappable key instead of one carrying
 * `..` path segments.
 *
 * @internal
 */
export function relativeUploadKey(roots: readonly string[], match: string): string {
  for (const root of roots) {
    const rel = relative(root, match)
    if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) continue
    return rel.split(sep).join(posix.sep)
  }
  return basename(match)
}

/**
 * Find upload plans that would write multiple local files to the same B2 key.
 *
 * @internal
 */
export function findDuplicateUploadFileNames(
  files: readonly UploadFileNameOwner[],
): UploadFileNameCollision[] {
  const byFileName = new Map<string, string[]>()
  for (const file of files) {
    const owners = byFileName.get(file.fileName)
    if (owners === undefined) {
      byFileName.set(file.fileName, [file.localPath])
    } else {
      owners.push(file.localPath)
    }
  }

  return Array.from(byFileName.entries())
    .filter(([, localPaths]) => localPaths.length > 1)
    .map(([fileName, localPaths]) => ({
      fileName,
      localPaths: [...localPaths].sort(compareStrings),
    }))
    .sort((a, b) => compareStrings(a.fileName, b.fileName))
}

function assertUniqueUploadFileNames(files: readonly UploadFileNameOwner[]) {
  const collisions = findDuplicateUploadFileNames(files)
  if (collisions.length === 0) return

  const details = collisions
    .map(
      (collision) =>
        `"${collision.fileName}" <= ${collision.localPaths.map((p) => `"${p}"`).join(', ')}`,
    )
    .join('; ')
  throw new Error(
    `Upload would overwrite ${collisions.length} B2 file name(s) from multiple local files: ${details}. ` +
      'Narrow the glob/include patterns or set a destination that preserves unique paths.',
  )
}

function compareResolvedFiles(a: ResolvedFile, b: ResolvedFile): number {
  return compareStrings(a.fileName, b.fileName) || compareStrings(a.localPath, b.localPath)
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

/**
 * Map a local source file to its B2 file name under the requested destination.
 *
 * @internal
 */
export function remapFileName(
  file: ResolvedFile,
  destination: string | undefined,
  isSingleExplicitFile: boolean,
): string {
  if (destination === undefined || destination === '') return file.fileName
  const dest = destination.replace(/\/+$/, '')
  if (isSingleExplicitFile && !destination.endsWith('/')) return dest
  return `${dest}/${file.fileName}`
}

async function prepareUploadPlan(
  file: ResolvedFile,
  inputs: ParsedInputs,
  isSingleExplicitFile: boolean,
): Promise<UploadPlan> {
  const size = file.size
  const lastModifiedMillis = inputs.preserveMtime ? Math.trunc(file.mtimeMs) : undefined
  const fileInfo = buildUploadFileInfo(inputs.fileInfo, lastModifiedMillis)
  validateFileInfo(fileInfo, uploadFileInfoTotalMaxBytes(inputs.encryption))

  return {
    localPath: file.localPath,
    fileName: remapFileName(file, inputs.destination, isSingleExplicitFile),
    size,
    lastModifiedMillis,
    fileInfo,
  }
}

async function uploadOne(
  bucket: Bucket,
  plan: UploadPlan,
  inputs: ParsedInputs,
  partConcurrency: number,
  groupedLog: boolean,
  signal?: AbortSignal,
): Promise<UploadedFile> {
  const { fileInfo, fileName, lastModifiedMillis, localPath, size } = plan

  // Stream the file from disk. The SDK's `bucket.upload` routes files larger
  // than the recommended part size through `uploadLargeFile`, which now
  // detects non-sliceable sources (StreamSource) and reads the stream once,
  // shipping one part at a time. Peak memory ≈ partSize regardless of file
  // size, so multi-GB uploads stay bounded.
  const nodeStream = createReadStream(localPath)
  const webStream = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>
  const source = new StreamSource(webStream, size)

  const onProgress = makeProgressListener(`upload[${fileName}]`)

  // `inputs.resume` is parsed but deliberately NOT forwarded to the SDK.
  // The SDK's resume implementation requires a sliceable source so it can
  // re-upload specific part offsets after a crash. The action uses
  // `StreamSource` (memory-bounded streaming from disk), which is read-once-
  // sequential and not sliceable; passing `resume: true` here would throw
  // `"resume is not supported on non-sliceable sources"`. The input is
  // kept in the action surface so this can be re-enabled if the action
  // ever offers a `BufferSource` fallback for users willing to trade RAM
  // for resumability.
  const result = await bucket.upload({
    fileName,
    source,
    concurrency: partConcurrency,
    ...(inputs.partSize !== undefined ? { partSize: inputs.partSize } : {}),
    ...(inputs.contentType !== undefined ? { contentType: inputs.contentType } : {}),
    ...(Object.keys(fileInfo).length > 0 ? { fileInfo } : {}),
    ...(lastModifiedMillis !== undefined ? { lastModifiedMillis } : {}),
    ...(inputs.encryption !== undefined ? { serverSideEncryption: inputs.encryption } : {}),
    ...(signal !== undefined ? { signal } : {}),
    onProgress,
  })

  // SDK now normalizes multipart `'none'` to `null` at the boundary, so
  // `result.contentSha1` is `string | null` directly.
  const sha1 = result.contentSha1
  const detailPrefix = groupedLog ? '  ' : ''
  core.info(`${detailPrefix}fileId=${result.fileId} sha1=${sha1 ?? 'multipart'}`)
  const resultFileInfo = Object.keys(result.fileInfo).length > 0 ? result.fileInfo : fileInfo

  return {
    localPath,
    fileName: result.fileName,
    fileId: result.fileId,
    size,
    contentSha1: sha1,
    fileInfo: resultFileInfo,
  }
}

function buildUploadFileInfo(
  inputFileInfo: Record<string, string>,
  lastModifiedMillis: number | undefined,
): Record<string, string> {
  const fileInfo: Record<string, string> = {}
  for (const [key, value] of Object.entries(inputFileInfo)) {
    const canonicalKey = key.toLowerCase()
    if (Object.hasOwn(fileInfo, canonicalKey)) {
      throw new Error(`Duplicate fileInfo key "${key}" from upload metadata`)
    }
    fileInfo[canonicalKey] = value
  }
  if (lastModifiedMillis !== undefined) {
    if (Object.hasOwn(fileInfo, 'src_last_modified_millis')) {
      throw new Error(
        `Duplicate fileInfo key "src_last_modified_millis" from 'preserve-mtime' input`,
      )
    }
    fileInfo.src_last_modified_millis = String(lastModifiedMillis)
  }
  return fileInfo
}
