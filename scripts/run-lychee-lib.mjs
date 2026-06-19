/**
 * Implementation for the pinned lychee runner used by `pnpm docs:links`.
 * It downloads and caches a pinned lychee binary so link checks are
 * reproducible from a clean checkout. CI intentionally runs this script
 * without `pnpm install`, so keep it dependency-free and limited to Node
 * built-ins.
 *
 * Supported platform, cache, and lychee-bump instructions live in
 * DEVELOPMENT.md's "Managed lychee binary" section; keep that section
 * authoritative so the maintenance runbook has one source of truth.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

/** @internal Test seam for the managed lychee version pin. */
export const LYCHEE_VERSION = '0.23.0'
const LYCHEE_TAG = `lychee-v${LYCHEE_VERSION}`
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BLOCK_SIZE = 512
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const INSTALL_LOCK_GRACE_MS = 30_000
const DOWNLOAD_ATTEMPTS = positiveIntegerOrDefault(process.env.LYCHEE_DOWNLOAD_ATTEMPTS, 3)
const DOWNLOAD_TIMEOUT_MS = positiveIntegerOrDefault(process.env.LYCHEE_DOWNLOAD_TIMEOUT_MS, 60_000)
const MIN_LOCK_TIMEOUT_MS = installLockTimeoutMs(DOWNLOAD_ATTEMPTS, DOWNLOAD_TIMEOUT_MS)
const LOCK_TIMEOUT_MS = Math.max(
  positiveIntegerOrDefault(process.env.LYCHEE_INSTALL_LOCK_TIMEOUT_MS, MIN_LOCK_TIMEOUT_MS),
  MIN_LOCK_TIMEOUT_MS,
)
const LYCHEE_ENV_KEYS = Object.freeze([
  'CI',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'NO_COLOR',
  'PATH',
  'PATHEXT',
  'Path',
  'SystemRoot',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
])

/** @internal Test seam for the shell-neutral default lychee invocation. */
export const DEFAULT_LYCHEE_ARGS = Object.freeze([
  '--offline',
  '--include-fragments',
  '--no-progress',
  '--exclude-path',
  '(^|[\\\\/])node_modules[\\\\/]',
  '**/*.md',
])

/** @internal Test seam for pinned release assets and their expected hashes. */
export const PLATFORM_ASSETS = Object.freeze({
  'darwin-arm64': {
    archive: true,
    archiveSha256: '1953bb425486e1b887757201e54e8fdf866c9cada6c270d8f6ed21ffbed4145a',
    binarySha256: 'd7ad5cddd46239310c448eb6ca0a10d8f3762d2d764d939881d0f6946c4224d3',
    name: 'lychee-arm64-macos.tar.gz',
  },
  'linux-arm64': {
    archive: true,
    archiveSha256: '97eb93b02a7d78a752fc33e5b0983439ccaadbf3db952b68a0a4401acd92e6e0',
    binarySha256: '5fe1b823d7e4ae88a20f9f3cab62e68e11f4271d57879dd2090c70cc394d0d77',
    name: 'lychee-aarch64-unknown-linux-gnu.tar.gz',
  },
  'linux-x64': {
    archive: true,
    archiveSha256: '1fcb6ccf10d04c22b8c5873c5b9cb7be32ee7423e12169d6f1a79a6f1962ef81',
    binarySha256: 'f1b2f598965a9772e0f19587947544129a07d9a2a156bcf9bdc8a524e325e712',
    name: 'lychee-x86_64-unknown-linux-gnu.tar.gz',
  },
  'win32-x64': {
    archive: false,
    archiveSha256: '0fda7ff0a60c0250939fc25361c2d4e6e7853c31c996733fdd5a1dd760bcb824',
    binarySha256: '0fda7ff0a60c0250939fc25361c2d4e6e7853c31c996733fdd5a1dd760bcb824',
    name: 'lychee-x86_64-windows.exe',
  },
})

export async function main(args = process.argv.slice(2)) {
  const asset = assetForPlatform()
  const cacheRoot = defaultCacheRoot()
  const binaryPath = binaryPathFor(asset, cacheRoot)
  await ensureLychee(asset, binaryPath, cacheRoot)

  const result = spawnSync(binaryPath, lycheeArgsFor(args), {
    cwd: REPO,
    env: environmentForLychee(process.env),
    stdio: 'inherit',
  })

  if (result.error !== undefined) {
    throw result.error
  }

  process.exit(result.status ?? 1)
}

// Except for isEntrypoint(), exports below are test-only seams that exercise
// runner behavior without spawning lychee. The CLI contract is main() plus
// isEntrypoint().

/** @internal Test seam for default/user lychee argument assembly. */
export function lycheeArgsFor(args = []) {
  const userArgs = args[0] === '--' ? args.slice(1) : args
  return [...DEFAULT_LYCHEE_ARGS, ...userArgs]
}

/** @internal Test seam for the minimal subprocess environment allowlist. */
export function environmentForLychee(sourceEnv = process.env) {
  const env = {}
  for (const key of LYCHEE_ENV_KEYS) {
    if (sourceEnv[key] !== undefined) env[key] = sourceEnv[key]
  }
  return env
}

/** @internal Test seam for supported-platform resolution and diagnostics. */
export function assetForPlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`
  const asset = PLATFORM_ASSETS[key]
  if (asset !== undefined) return { key, ...asset }

  if (key === 'darwin-x64') {
    throw new Error(
      `${LYCHEE_TAG} does not publish an Intel macOS binary. ` +
        'Run `pnpm docs:links` on Apple Silicon macOS, Linux, or Windows, ' +
        'or rely on the CI link-check job for this gate.',
    )
  }

  const supported = Object.keys(PLATFORM_ASSETS).sort().join(', ')
  throw new Error(
    `No pinned ${LYCHEE_TAG} binary is available for ${key}. ` +
      `Supported platforms: ${supported}.`,
  )
}

/** @internal Test seam for cached-binary hash verification. */
export function binaryMatchesHash(path, expectedSha256) {
  if (!existsSync(path)) return false
  try {
    return sha256File(path) === expectedSha256
  } catch {
    return false
  }
}

async function ensureLychee(asset, binaryPath, cacheRoot) {
  if (binaryMatchesHash(binaryPath, asset.binarySha256)) return binaryPath

  mkdirSync(cacheRoot, { recursive: true })
  await withInstallLock(join(cacheRoot, `${LYCHEE_TAG}-${asset.key}.lock`), async () => {
    if (!binaryMatchesHash(binaryPath, asset.binarySha256)) {
      await installLychee(asset, binaryPath, cacheRoot)
    }
  })

  if (!binaryMatchesHash(binaryPath, asset.binarySha256)) {
    throw new Error(`Cached lychee binary failed SHA-256 verification: ${binaryPath}`)
  }
  return binaryPath
}

async function installLychee(asset, binaryPath, cacheRoot) {
  const tempDir = join(
    cacheRoot,
    '.tmp',
    `${asset.key}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const downloadPath = join(tempDir, asset.name)
  const tempBinaryPath = join(tempDir, binaryNameFor(asset.key))
  const url = `https://github.com/lycheeverse/lychee/releases/download/${LYCHEE_TAG}/${asset.name}`

  mkdirSync(tempDir, { recursive: true })
  try {
    console.error(`Downloading lychee ${LYCHEE_VERSION} from ${url}`)
    await downloadWithRetries(url, downloadPath)
    installDownloadedAsset(asset, downloadPath, tempBinaryPath)

    mkdirSync(dirname(binaryPath), { recursive: true })
    rmSync(binaryPath, { force: true, recursive: true })
    renameSync(tempBinaryPath, binaryPath)
  } finally {
    rmSync(tempDir, { force: true, recursive: true })
  }
}

/** @internal Test seam for checksum-gated archive/binary installation. */
export function installDownloadedAsset(asset, downloadPath, binaryPath) {
  verifyFileSha256(downloadPath, asset.archiveSha256, asset.name)

  if (asset.archive) {
    extractLycheeArchive(downloadPath, binaryPath)
  } else {
    copyFileSync(downloadPath, binaryPath)
  }

  verifyFileSha256(binaryPath, asset.binarySha256, 'lychee binary')
  chmodSync(binaryPath, 0o755)
}

/** @internal Test seam for bounded download retry behavior. */
export async function downloadWithRetries(url, destination, options = {}) {
  const attempts = positiveIntegerOrDefault(options.attempts, DOWNLOAD_ATTEMPTS)
  const timeoutMs = positiveIntegerOrDefault(options.timeoutMs, DOWNLOAD_TIMEOUT_MS)
  const maxBytes = positiveIntegerOrDefault(options.maxBytes, MAX_DOWNLOAD_BYTES)
  const fetchImpl = options.fetchImpl ?? fetch
  let lastError

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    rmSync(destination, { force: true })
    try {
      await downloadOnce(url, destination, fetchImpl, timeoutMs, maxBytes)
      return
    } catch (err) {
      lastError = err
      if (attempt === attempts || !isRetryableDownloadError(err)) break

      const delayMs = 500 * attempt
      console.error(
        `Download attempt ${attempt}/${attempts} failed: ${formatError(err)}; ` +
          `retrying in ${delayMs}ms`,
      )
      await sleep(delayMs)
    }
  }

  rmSync(destination, { force: true })
  throw new Error(
    `Failed to download ${url} after ${attempts} attempt(s): ${formatError(lastError)}`,
  )
}

/** @internal Test seam for safe lychee archive extraction. */
export function extractLycheeArchive(archivePath, destination) {
  const archive = gunzipSync(readFileSync(archivePath))
  let foundLychee = false

  for (let offset = 0; offset + BLOCK_SIZE <= archive.length; ) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE)
    if (isZeroBlock(header)) break

    const entryPath = tarEntryPath(header)
    validateTarEntryPath(entryPath)
    const size = parseTarOctal(header, 124, 12)
    const type = tarEntryType(header)
    const dataStart = offset + BLOCK_SIZE
    const dataEnd = dataStart + size

    if (dataEnd > archive.length) {
      throw new Error(`Invalid lychee archive: ${entryPath} extends past end of archive`)
    }
    if (type === '1' || type === '2') {
      throw new Error(`Refusing to extract link entry from lychee archive: ${entryPath}`)
    }
    if (entryPath === 'lychee') {
      if (type !== '0') {
        throw new Error(`Refusing to extract non-file lychee archive entry: ${entryPath}`)
      }
      if (foundLychee) {
        throw new Error('Invalid lychee archive: duplicate lychee entry')
      }
      writeFileSync(destination, archive.subarray(dataStart, dataEnd), { mode: 0o600 })
      foundLychee = true
    }

    offset = dataStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
  }

  if (!foundLychee) {
    throw new Error('Invalid lychee archive: missing lychee binary')
  }
}

function validateTarEntryPath(entryPath) {
  const parts = entryPath.split('/')
  if (
    entryPath.startsWith('/') ||
    entryPath.includes('\\') ||
    parts.some((part) => part === '..')
  ) {
    throw new Error(`Refusing unsafe lychee archive path: ${entryPath}`)
  }
}

function verifyFileSha256(path, expectedSha256, label) {
  const actual = sha256File(path)
  if (actual !== expectedSha256) {
    throw new Error(`${label} checksum mismatch: expected ${expectedSha256}, got ${actual}`)
  }
}

/** @internal Test seam for numeric environment option parsing. */
export function positiveIntegerOrDefault(value, defaultValue) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
}

/** @internal Test seam for install-lock wait derivation. */
export function installLockTimeoutMs(downloadAttempts, downloadTimeoutMs) {
  const retryDelayMs = (downloadAttempts * (downloadAttempts - 1) * 500) / 2
  return downloadAttempts * downloadTimeoutMs + retryDelayMs + INSTALL_LOCK_GRACE_MS
}

function defaultCacheRoot() {
  return process.env.LYCHEE_CACHE_DIR ?? join(REPO, 'node_modules', '.cache', 'lychee')
}

function binaryPathFor(asset, cacheRoot) {
  return join(cacheRoot, LYCHEE_TAG, asset.key, binaryNameFor(asset.key))
}

function binaryNameFor(platformKey) {
  return platformKey.startsWith('win32-') ? 'lychee.exe' : 'lychee'
}

async function downloadOnce(url, destination, fetchImpl, timeoutMs, maxBytes) {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'backblaze-labs/b2-action docs:links' },
      signal,
    })
    if (!response.ok || response.body === null) {
      throw new DownloadFailure(`HTTP ${response.status}`, {
        retryable: isRetryableHttpStatus(response.status),
        status: response.status,
      })
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null) {
      const size = Number(contentLength)
      if (Number.isFinite(size) && size > maxBytes) {
        throw new DownloadFailure(
          `asset exceeds ${maxBytes} byte download limit: Content-Length ${contentLength}`,
          { retryable: false },
        )
      }
    }
    await pipeline(
      Readable.fromWeb(response.body),
      limitDownloadBytes(maxBytes),
      createWriteStream(destination),
      { signal },
    )
  } catch (err) {
    if (signal.aborted) {
      throw new DownloadFailure(`timed out after ${timeoutMs}ms`, { retryable: true })
    }
    if (err instanceof DownloadFailure) throw err
    throw new DownloadFailure(formatError(err), { retryable: true })
  }
}

async function withInstallLock(lockDir, fn) {
  const startedAt = Date.now()
  while (true) {
    try {
      mkdirSync(lockDir)
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for lychee install lock: ${lockDir}. ` +
            'If no docs:links process is running, remove this stale lock directory and retry.',
        )
      }
      await sleep(100)
    }
  }

  try {
    return await fn()
  } finally {
    rmSync(lockDir, { force: true, recursive: true })
  }
}

function isRetryableDownloadError(err) {
  return err instanceof DownloadFailure ? err.retryable : true
}

function isRetryableHttpStatus(status) {
  return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500
}

function limitDownloadBytes(maxBytes) {
  return async function* limit(source) {
    let written = 0
    for await (const chunk of source) {
      written += chunk.byteLength ?? chunk.length ?? Buffer.byteLength(String(chunk))
      if (written > maxBytes) {
        throw new DownloadFailure(`asset exceeds ${maxBytes} byte download limit`, {
          retryable: false,
        })
      }
      yield chunk
    }
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tarEntryPath(header) {
  const name = tarString(header, 0, 100)
  const prefix = tarString(header, 345, 155)
  if (name === '') throw new Error('Invalid lychee archive: empty tar entry name')
  return prefix === '' ? name : `${prefix}/${name}`
}

function tarEntryType(header) {
  const raw = tarString(header, 156, 1)
  return raw === '' ? '0' : raw
}

function tarString(header, start, length) {
  const raw = header.subarray(start, start + length)
  const end = raw.indexOf(0)
  return raw
    .subarray(0, end === -1 ? raw.length : end)
    .toString('utf8')
    .trim()
}

function parseTarOctal(header, start, length) {
  const raw = tarString(header, start, length)
  const parsed = Number.parseInt(raw || '0', 8)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid lychee archive: invalid tar size "${raw}"`)
  }
  return parsed
}

function isZeroBlock(block) {
  for (const byte of block) {
    if (byte !== 0) return false
  }
  return true
}

function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

class DownloadFailure extends Error {
  constructor(message, { retryable, status } = {}) {
    super(message)
    this.name = 'DownloadFailure'
    this.retryable = retryable ?? false
    this.status = status
  }
}

export function isEntrypoint(metaUrl, argv1) {
  if (argv1 === undefined) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1))
  } catch {
    return false
  }
}
