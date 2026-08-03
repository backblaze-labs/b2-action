import * as core from '@actions/core'
import type { EncryptionSetting } from '@backblaze-labs/b2-sdk'
import { parseSse } from './sse.ts'

/**
 * Discriminator the action's dispatcher switches on. Matches the values
 * accepted by the `action:` input in `action.yml`. Adding a new verb
 * requires updating this union, the runtime `VALID_ACTIONS` list,
 * `ACTION_EFFECTS`, the dispatcher in `src/main.ts`, and the documentation
 * surfaces.
 */
export type ActionName =
  | 'upload'
  | 'download'
  | 'sync'
  | 'copy'
  | 'delete'
  | 'presign'
  | 'list'
  | 'hide'
  | 'unhide'
  | 'verify'
  | 'retention'
  | 'head'
  | 'purge'

const VALID_ACTIONS: readonly ActionName[] = [
  'upload',
  'download',
  'sync',
  'copy',
  'delete',
  'presign',
  'list',
  'hide',
  'unhide',
  'verify',
  'retention',
  'head',
  'purge',
]

type ActionEffect = {
  readonly kind: 'read' | 'write'
  readonly honorsDryRun: boolean
}

/**
 * Runtime side-effect policy for each action verb.
 *
 * @internal
 */
export const ACTION_EFFECTS = {
  upload: { kind: 'write', honorsDryRun: false },
  download: { kind: 'read', honorsDryRun: false },
  sync: { kind: 'write', honorsDryRun: true },
  copy: { kind: 'write', honorsDryRun: false },
  delete: { kind: 'write', honorsDryRun: true },
  presign: { kind: 'read', honorsDryRun: false },
  list: { kind: 'read', honorsDryRun: false },
  hide: { kind: 'write', honorsDryRun: false },
  unhide: { kind: 'write', honorsDryRun: false },
  verify: { kind: 'read', honorsDryRun: false },
  retention: { kind: 'write', honorsDryRun: false },
  head: { kind: 'read', honorsDryRun: false },
  purge: { kind: 'write', honorsDryRun: true },
} as const satisfies Record<ActionName, ActionEffect>

/** How `sync` decides whether two files match. Drives the SDK's `synchronize()`. */
export type CompareMode = 'modtime' | 'size' | 'none'
/** What `sync` does with destination-only files when reconciling. */
export type KeepMode = 'no-delete' | 'delete' | 'keep-days'
/** Direction of a `sync`: `auto` infers from whether `source` is local or remote. */
export type SyncDirection = 'auto' | 'up' | 'down'
/** B2 Object Lock retention mode. `none` clears any prior retention. */
export type RetentionMode = 'compliance' | 'governance' | 'none'
/** B2 Object Lock legal-hold state. */
export type LegalHold = 'on' | 'off'

const VALID_COMPARE: readonly CompareMode[] = ['modtime', 'size', 'none']
const VALID_KEEP: readonly KeepMode[] = ['no-delete', 'delete', 'keep-days']
const VALID_DIRECTION: readonly SyncDirection[] = ['auto', 'up', 'down']
const VALID_RETENTION_MODE: readonly RetentionMode[] = ['compliance', 'governance', 'none']
const VALID_LEGAL_HOLD: readonly LegalHold[] = ['on', 'off']
const APPLICATION_KEY_ID_ENV = 'B2_APPLICATION_KEY_ID'
const APPLICATION_KEY_ENV = 'B2_APPLICATION_KEY'
const FILE_INFO_KEY_PATTERN = /^[a-zA-Z0-9_.`~!#$%^&*'|+-]+$/
const FILE_INFO_KEY_MAX_BYTES = 50
const FILE_INFO_MAX_ENTRIES = 10
const FILE_INFO_TOTAL_MAX_BYTES = 7000
const FILE_INFO_TOTAL_MAX_BYTES_WITH_ENCRYPTION = 2048
const CONTENT_HEADER_FILE_INFO_KEYS = [
  ['cache-control', 'b2-cache-control'],
  ['content-disposition', 'b2-content-disposition'],
  ['content-language', 'b2-content-language'],
  ['expires', 'b2-expires'],
] as const
const utf8Encoder = new TextEncoder()

/**
 * The fully-parsed, fully-validated action surface. Built by
 * {@link parseInputs} from `INPUT_*` env vars (via `@actions/core`); every
 * command in `src/commands/` consumes a frozen instance of this shape.
 *
 * Most fields map 1:1 to inputs declared in `action.yml`. Defaults and
 * optionality match the YAML surface; see `action.yml` for the user-facing
 * documentation per input.
 */
export interface ParsedInputs {
  /** Which verb to dispatch to. */
  action: ActionName
  /** B2 application key ID. Masked at parse time via `core.setSecret` (defense in depth). */
  applicationKeyId: string
  /** B2 application key (the secret). Masked at parse time via `core.setSecret`. */
  applicationKey: string
  /** Destination bucket name for the action. */
  bucket: string
  /** Cross-bucket `copy` source bucket. Undefined means same-bucket copy. */
  sourceBucket: string | undefined
  /**
   * Verb-dependent source. Upload/sync: a local path or glob. Download/copy/
   * delete/presign/list/hide/unhide/verify/retention/head/purge: a B2 file
   * name or prefix (trailing `/` means prefix mode for verbs that support it).
   */
  source: string | undefined
  /**
   * Verb-dependent destination. Upload/sync: B2 file name or prefix.
   * Download: local path. Copy: destination file name. Other verbs: ignored.
   */
  destination: string | undefined
  /** Glob patterns to include during upload/sync expansion. */
  include: string[]
  /** Glob patterns to exclude during upload/sync expansion. Default: `.git/**`. */
  exclude: string[]
  /** Parallel parts/files for upload/sync. */
  concurrency: number
  /** Multipart part size in bytes. Undefined defers to the SDK's recommendation. */
  partSize: number | undefined
  /** Resume an in-progress multipart upload. */
  resume: boolean
  /** Content-Type to set on uploaded objects. Undefined leaves B2's auto-detect. */
  contentType: string | undefined
  /** Custom B2 fileInfo metadata (`X-Bz-Info-*`) to set on uploaded objects. */
  fileInfo: Record<string, string>
  /** Preserve each local file's mtime as B2 `src_last_modified_millis`. */
  preserveMtime: boolean
  /** Preview without executing (sync/delete/purge). */
  dryRun: boolean
  /** Permit whole-bucket purge when `source` is empty or `/`. */
  allowBucketPurge: boolean
  /** Presigned-URL TTL in seconds. */
  presignTtlSeconds: number
  /** Override B2 realm endpoint for staging / custom realms. */
  endpoint: string | undefined
  /** Fail the action when upload/sync matches zero files. */
  failOnEmpty: boolean
  /** Raw `sse:` input value as the user typed it. Retained for diagnostics. */
  sse: string | undefined
  /** Parsed SSE specification ready to hand to the SDK. */
  encryption: EncryptionSetting | undefined
  /** How `sync` compares files. */
  compareMode: CompareMode
  /** How `sync` treats destination-only files. */
  keepMode: KeepMode
  /** Retention window in days for `keep-mode: keep-days`. */
  keepDays: number | undefined
  /** Direction of a `sync` (auto-detected when set to `auto`). */
  syncDirection: SyncDirection
  /** Cap on listed/presigned entries for `list` and prefix `presign`. */
  maxResults: number
  /** Literal SHA-1 to compare against in `verify` (when set, no local read). */
  expectedSha1: string | undefined
  /** Object Lock retention mode to apply (`retention` verb). */
  retentionMode: RetentionMode | undefined
  /** ISO-8601 timestamp until which retention applies. Required with `retentionMode`. */
  retentionUntil: string | undefined
  /** Legal-hold state to apply (`retention` verb). */
  legalHold: LegalHold | undefined
  /** Allow shortening a governance-mode retention (requires key capability). */
  bypassGovernance: boolean
}

/**
 * Sensitive raw values that can appear in parser-scope errors before
 * {@link parseInputs} returns its structured output.
 */
export function collectInputSecretsForScrubbing(): string[] {
  const secretValues = new Set<string>()
  addSecretValue(secretValues, core.getInput('application-key-id'))
  addSecretValue(secretValues, process.env[APPLICATION_KEY_ID_ENV])
  addSecretValue(secretValues, core.getInput('application-key'))
  addSecretValue(secretValues, process.env[APPLICATION_KEY_ENV])
  addSseSecretValue(secretValues, core.getInput('sse'))
  return [...secretValues]
}

/**
 * Parse and validate inputs.
 *
 * Credentials lookup order:
 *
 *   1. `application-key-id` / `application-key` action inputs
 *   2. `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` env vars (the official
 *      contract used by the Backblaze b2 CLI and the @backblaze-labs/b2-sdk).
 *
 * The credential value, once resolved, is immediately masked via `core.setSecret`
 * so any accidental echo (including from a misbehaving sub-process) is redacted
 * in workflow logs.
 */
export function parseInputs(): ParsedInputs {
  const action = parseEnum('action', required('action').toLowerCase(), VALID_ACTIONS)

  const applicationKeyId = resolveCredential('application-key-id', APPLICATION_KEY_ID_ENV)
  const applicationKey = resolveCredential('application-key', APPLICATION_KEY_ENV)
  // The keyId is identifying (not the secret half of the HMAC pair), but mask
  // it anyway for defense in depth: the canonical AWS analogue mask AKIA-style
  // IDs in CI logs, and masking costs nothing in debuggability since the user
  // already knows which key they passed.
  core.setSecret(applicationKeyId)
  core.setSecret(applicationKey)

  const bucket = required('bucket')
  const sourceBucket = optional('source-bucket')
  const allowBucketPurge = parseBool(
    'allow-bucket-purge',
    core.getInput('allow-bucket-purge') || 'false',
  )
  const source = optionalSource(action, allowBucketPurge)
  const destination = optional('destination')

  const include = splitCsv(optional('include'))
  const exclude = splitCsv(optional('exclude'))

  const concurrency = parsePositiveInt('concurrency', core.getInput('concurrency') || '4')
  const partSizeInput = optional('part-size')
  const partSize =
    partSizeInput !== undefined ? parsePositiveInt('part-size', partSizeInput) : undefined

  const resume = parseBool('resume', core.getInput('resume') || 'true')
  const dryRun = parseBool('dry-run', core.getInput('dry-run') || 'false')
  const failOnEmpty = parseBool('fail-on-empty', core.getInput('fail-on-empty') || 'true')
  const bypassGovernance = parseBool(
    'bypass-governance',
    core.getInput('bypass-governance') || 'false',
  )

  const presignTtlSeconds = parsePositiveInt('presign-ttl', core.getInput('presign-ttl') || '3600')
  const maxResults = parsePositiveInt('max-results', core.getInput('max-results') || '1000')

  const endpoint = optional('endpoint')
  const sse = optional('sse')
  const encryption = parseSse(sse)

  const contentType = optional('content-type')
  const fileInfo = parseFileInfo(optional('file-info'))
  for (const [inputName, fileInfoKey] of CONTENT_HEADER_FILE_INFO_KEYS) {
    addFileInfo(fileInfo, fileInfoKey, optional(inputName), inputName, { allowReserved: true })
  }
  validateFileInfo(fileInfo, uploadFileInfoTotalMaxBytes(encryption))
  const preserveMtime = parseBool('preserve-mtime', core.getInput('preserve-mtime') || 'false')
  if (preserveMtime && Object.hasOwn(fileInfo, 'src_last_modified_millis')) {
    throw new Error(`Duplicate fileInfo key "src_last_modified_millis" from 'preserve-mtime' input`)
  }
  const expectedSha1 = optional('expected-sha1')
  const retentionUntil = optional('retention-until')

  const compareMode = parseEnum(
    'compare-mode',
    (core.getInput('compare-mode') || 'modtime').toLowerCase(),
    VALID_COMPARE,
  )
  const keepMode = parseEnum(
    'keep-mode',
    (core.getInput('keep-mode') || 'no-delete').toLowerCase(),
    VALID_KEEP,
  )
  const keepDaysInput = optional('keep-days')
  const keepDays =
    keepDaysInput !== undefined ? parsePositiveInt('keep-days', keepDaysInput) : undefined
  if (keepMode === 'keep-days' && keepDays === undefined) {
    // The SDK defaults `keepDays` to 0, which deletes every orphan immediately
    // and makes `keep-days` behave exactly like `delete`. Fail loudly instead.
    throw new Error("'keep-days' is required when 'keep-mode' is 'keep-days'")
  }
  if (keepDays !== undefined && keepMode !== 'keep-days') {
    core.warning(
      `'keep-days' is ignored because 'keep-mode' is '${keepMode}'; set 'keep-mode: keep-days' to apply it.`,
    )
  }

  const syncDirection = parseEnum(
    'direction',
    (core.getInput('direction') || 'auto').toLowerCase(),
    VALID_DIRECTION,
  )
  const retentionMode = parseOptionalEnum(
    'retention-mode',
    optional('retention-mode')?.toLowerCase(),
    VALID_RETENTION_MODE,
  )
  const legalHold = parseOptionalEnum(
    'legal-hold',
    optional('legal-hold')?.toLowerCase(),
    VALID_LEGAL_HOLD,
  )

  return {
    action,
    applicationKeyId,
    applicationKey,
    bucket,
    sourceBucket,
    source,
    destination,
    include,
    exclude,
    concurrency,
    partSize,
    resume,
    contentType,
    fileInfo,
    preserveMtime,
    dryRun,
    allowBucketPurge,
    presignTtlSeconds,
    endpoint,
    failOnEmpty,
    sse,
    encryption,
    compareMode,
    keepMode,
    keepDays,
    syncDirection,
    maxResults,
    expectedSha1,
    retentionMode,
    retentionUntil,
    legalHold,
    bypassGovernance,
  }
}

/**
 * Validate that `inputs.source` is set and non-empty, returning the value.
 * Throws a uniform error message naming the verb so the workflow log surfaces
 * exactly what's missing. Commands that allow an empty-string source for
 * special semantics (e.g. `purge` with explicit whole-bucket scope) should
 * not use this helper.
 */
export function requireSource(
  source: string | undefined,
  verb: string,
  description?: string,
): string {
  if (source === undefined || source === '') {
    const tail = description !== undefined ? ` (${description})` : ''
    throw new Error(`'source' input is required for '${verb}' action${tail}`)
  }
  return source
}

/**
 * Validate that `raw` is one of `valid`, narrowing the return type.
 *
 * Replaces the previous pattern of one type-guard + one throw per enum:
 *
 *   const x = parseEnum('compare-mode', raw, VALID_COMPARE)
 *
 * Throws a uniform error message that lists the legal values.
 *
 * @internal
 */
export function parseEnum<T extends string>(name: string, raw: string, valid: readonly T[]): T {
  if ((valid as readonly string[]).includes(raw)) return raw as T
  throw new Error(`Invalid '${name}' input: "${raw}". Must be one of: ${valid.join(', ')}`)
}

/**
 * Like {@link parseEnum} but passes through `undefined`. Used for inputs that
 * are optional but, when set, must be one of a known set.
 */
function parseOptionalEnum<T extends string>(
  name: string,
  raw: string | undefined,
  valid: readonly T[],
): T | undefined {
  return raw === undefined ? undefined : parseEnum(name, raw, valid)
}

function required(name: string): string {
  // `@actions/core` throws on missing required inputs, so this never returns
  // empty. Wrapping the call only exists so the throw site has a uniform
  // shape with the rest of the input parsers.
  return core.getInput(name, { required: true })
}

function optional(name: string): string | undefined {
  const v = core.getInput(name)
  return v === '' ? undefined : v
}

function optionalSource(action: ActionName, allowBucketPurge: boolean): string | undefined {
  const v = core.getInput('source')
  if (v !== '') return v
  return action === 'purge' && allowBucketPurge ? '' : undefined
}

function addSecretValue(secretValues: Set<string>, value: string | undefined): void {
  if (value === undefined || value === '') return
  const trimmed = value.trim()
  for (const secret of new Set([value, trimmed])) {
    if (secret === '' || secretValues.has(secret)) continue
    core.setSecret(secret)
    secretValues.add(secret)
  }
}

function addSseSecretValue(secretValues: Set<string>, value: string | undefined): void {
  if (value === undefined) return
  const normalized = value.trim()
  if (normalized === '' || normalized.toUpperCase() === 'B2') return

  addSecretValue(secretValues, value)
  if (normalized.startsWith('C:') || normalized.startsWith('c:')) {
    addSecretValue(secretValues, normalized.slice(2).trim())
  }
}

function resolveCredential(inputName: string, envName: string): string {
  const fromInput = optional(inputName)
  if (fromInput !== undefined) return fromInput

  const fromEnv = process.env[envName]
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv

  throw new Error(`Missing credential: set input '${inputName}' or env var '${envName}'`)
}

/**
 * Parse a comma-separated action input, trimming entries and dropping blanks.
 *
 * @internal
 */
export function splitCsv(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * Parse upload fileInfo metadata from newline-delimited or simple
 * comma-separated `key=value` entries. Newline mode preserves commas inside
 * values.
 *
 * @internal
 */
export function parseFileInfo(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === '') return {}
  const pairs = /[\r\n]/.test(value) ? value.split(/\r?\n|\r/) : value.split(',')
  const fileInfo: Record<string, string> = {}

  for (const rawPair of pairs) {
    const pair = rawPair.trim()
    if (pair === '') continue
    const equalsIndex = pair.indexOf('=')
    if (equalsIndex <= 0) {
      throw new Error(`Invalid 'file-info' entry "${pair}". Expected key=value.`)
    }
    const key = pair.slice(0, equalsIndex).trim()
    const parsedValue = pair.slice(equalsIndex + 1).trim()
    addFileInfo(fileInfo, key, parsedValue, 'file-info', { allowReserved: false })
  }

  return fileInfo
}

interface AddFileInfoOptions {
  allowReserved: boolean
}

function addFileInfo(
  fileInfo: Record<string, string>,
  key: string,
  value: string | undefined,
  inputName: string,
  options: AddFileInfoOptions,
): void {
  if (value === undefined) return
  const canonicalKey = key.toLowerCase()
  if (!options.allowReserved && canonicalKey.startsWith('b2-')) {
    throw new Error(
      `Reserved fileInfo key "${key}" from '${inputName}' input must use the dedicated upload inputs such as content-type, cache-control, content-disposition, content-language, or expires`,
    )
  }
  if (Object.hasOwn(fileInfo, canonicalKey)) {
    throw new Error(`Duplicate fileInfo key "${key}" from '${inputName}' input`)
  }
  fileInfo[canonicalKey] = value
}

/**
 * Return the upload fileInfo byte budget for the active encryption mode.
 *
 * @internal
 */
export function uploadFileInfoTotalMaxBytes(encryption: EncryptionSetting | undefined): number {
  return encryption === undefined
    ? FILE_INFO_TOTAL_MAX_BYTES
    : FILE_INFO_TOTAL_MAX_BYTES_WITH_ENCRYPTION
}

/**
 * Validate upload fileInfo metadata before forwarding it to the B2 SDK.
 *
 * @internal
 */
export function validateFileInfo(
  fileInfo: Record<string, string>,
  totalMaxBytes = FILE_INFO_TOTAL_MAX_BYTES,
): void {
  const entries = Object.entries(fileInfo)
  if (entries.length > FILE_INFO_MAX_ENTRIES) {
    throw new Error(`Invalid fileInfo: ${entries.length} entries exceeds ${FILE_INFO_MAX_ENTRIES}`)
  }

  let totalBytes = 0
  const seenCanonicalKeys = new Set<string>()
  for (const [key, value] of entries) {
    const canonicalKey = key.toLowerCase()
    if (seenCanonicalKeys.has(canonicalKey)) {
      throw new Error(`Duplicate fileInfo key "${key}" from upload metadata`)
    }
    seenCanonicalKeys.add(canonicalKey)

    if (!FILE_INFO_KEY_PATTERN.test(key)) {
      throw new Error(
        `Invalid fileInfo key "${key}" from 'file-info'. Keys must match ${FILE_INFO_KEY_PATTERN.source}`,
      )
    }

    const keyBytes = utf8Encoder.encode(key).byteLength
    if (keyBytes > FILE_INFO_KEY_MAX_BYTES) {
      throw new Error(
        `Invalid fileInfo key "${key}": ${keyBytes} bytes exceeds ${FILE_INFO_KEY_MAX_BYTES}`,
      )
    }

    const valueBytes = utf8Encoder.encode(value).byteLength
    const remainingValueBytes = Math.max(0, totalMaxBytes - totalBytes - keyBytes)
    if (valueBytes > remainingValueBytes) {
      throw new Error(
        `Invalid fileInfo value for "${key}": ${valueBytes} bytes exceeds ${remainingValueBytes}`,
      )
    }
    totalBytes += keyBytes + valueBytes
  }

  if (totalBytes > totalMaxBytes) {
    throw new Error(`Invalid fileInfo: total size ${totalBytes} bytes exceeds ${totalMaxBytes}`)
  }
}

/**
 * Parse the documented boolean input spellings accepted by this action.
 *
 * @internal
 */
export function parseBool(name: string, raw: string): boolean {
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new Error(`Invalid boolean for '${name}': "${raw}"`)
}

/**
 * Parse a strictly positive integer input.
 *
 * @internal
 */
export function parsePositiveInt(name: string, raw: string): number {
  const trimmed = raw.trim()
  const n = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || n <= 0 || !Number.isSafeInteger(n)) {
    throw new Error(`Invalid positive integer for '${name}': "${raw}"`)
  }
  return n
}
