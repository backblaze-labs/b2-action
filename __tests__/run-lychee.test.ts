import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts/run-lychee.mjs')
const runLychee = (await import(pathToFileURL(scriptPath).href)) as {
  DEFAULT_LYCHEE_ARGS: readonly string[]
  assetForPlatform: (platform?: string, arch?: string) => { key: string }
  binaryMatchesHash: (path: string, expectedSha256: string) => boolean
  downloadWithRetries: (
    url: string,
    destination: string,
    options?: {
      attempts?: number
      fetchImpl?: typeof fetch
      timeoutMs?: number
    },
  ) => Promise<void>
  extractLycheeArchive: (archivePath: string, destination: string) => void
  installDownloadedAsset: (
    asset: {
      archive: boolean
      archiveSha256: string
      binarySha256: string
      name: string
    },
    downloadPath: string,
    binaryPath: string,
  ) => void
}

describe('run-lychee helper', () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'b2-run-lychee-'))
  })

  afterEach(async () => {
    await rm(workDir, { force: true, recursive: true })
  })

  it('keeps default lychee args shell-neutral for Windows and POSIX', () => {
    expect(runLychee.DEFAULT_LYCHEE_ARGS).toEqual([
      '--offline',
      '--include-fragments',
      '--no-progress',
      '--verbose',
      '--exclude-path',
      '(^|/)node_modules/',
      '**/*.md',
    ])
    expect(
      runLychee.DEFAULT_LYCHEE_ARGS.some((arg) => arg.includes("'") || arg.includes('"')),
    ).toBe(false)
  })

  it('documents the unsupported Intel macOS asset gap in the platform error', () => {
    expect(() => runLychee.assetForPlatform('darwin', 'x64')).toThrow(/Intel macOS/)
  })

  it('does not trust a cached binary that only prints the expected version', async () => {
    const fakeBinary = join(workDir, 'lychee')
    await writeFile(fakeBinary, '#!/bin/sh\necho "lychee 0.23.0"\n')
    await chmod(fakeBinary, 0o755)

    expect(runLychee.binaryMatchesHash(fakeBinary, '0'.repeat(64))).toBe(false)
  })

  it('rejects a tampered archive before writing a binary', async () => {
    const archivePath = join(workDir, 'lychee.tar.gz')
    const binaryPath = join(workDir, 'lychee')
    await writeFile(archivePath, makeTarGz([{ body: 'fake', name: 'lychee' }]))

    expect(() =>
      runLychee.installDownloadedAsset(
        {
          archive: true,
          archiveSha256: '0'.repeat(64),
          binarySha256: sha256('fake'),
          name: 'lychee.tar.gz',
        },
        archivePath,
        binaryPath,
      ),
    ).toThrow(/checksum mismatch/)
    await expect(readFile(binaryPath)).rejects.toThrow(/ENOENT/)
  })

  it('rejects a tampered binary that spoofs a valid-looking version', async () => {
    const downloadPath = join(workDir, 'lychee.exe')
    const binaryPath = join(workDir, 'installed-lychee.exe')
    const fakeBinary = '#!/bin/sh\necho "lychee 0.23.0"\n'
    await writeFile(downloadPath, fakeBinary)

    expect(() =>
      runLychee.installDownloadedAsset(
        {
          archive: false,
          archiveSha256: sha256(fakeBinary),
          binarySha256: 'f'.repeat(64),
          name: 'lychee.exe',
        },
        downloadPath,
        binaryPath,
      ),
    ).toThrow(/lychee binary checksum mismatch/)
  })

  it('extracts the expected lychee tar member only', async () => {
    const archivePath = join(workDir, 'lychee.tar.gz')
    const binaryPath = join(workDir, 'lychee')
    await writeFile(
      archivePath,
      makeTarGz([
        { body: 'ignored', name: 'README.md' },
        { body: 'real lychee', name: 'lychee' },
      ]),
    )

    runLychee.extractLycheeArchive(archivePath, binaryPath)

    await expect(readFile(binaryPath, 'utf8')).resolves.toBe('real lychee')
  })

  it('rejects archive traversal entries', async () => {
    const archivePath = join(workDir, 'lychee.tar.gz')
    const binaryPath = join(workDir, 'lychee')
    await writeFile(
      archivePath,
      makeTarGz([
        { body: 'escape', name: '../escape' },
        { body: 'real lychee', name: 'lychee' },
      ]),
    )

    expect(() => runLychee.extractLycheeArchive(archivePath, binaryPath)).toThrow(/unsafe/)
    await expect(readFile(join(workDir, '..', 'escape'))).rejects.toThrow(/ENOENT/)
  })

  it('retries retryable download failures', async () => {
    const destination = join(workDir, 'downloaded')
    let attempts = 0
    const fetchImpl: typeof fetch = async () => {
      attempts += 1
      return attempts === 1
        ? new Response('temporary', { status: 503 })
        : new Response('ok', { status: 200 })
    }

    await runLychee.downloadWithRetries('https://example.test/lychee', destination, {
      attempts: 2,
      fetchImpl,
      timeoutMs: 1_000,
    })

    expect(attempts).toBe(2)
    await expect(readFile(destination, 'utf8')).resolves.toBe('ok')
  })

  it('fails stalled downloads with a bounded timeout', async () => {
    const destination = join(workDir, 'downloaded')
    const fetchImpl: typeof fetch = async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
    }

    await expect(
      runLychee.downloadWithRetries('https://example.test/lychee', destination, {
        attempts: 1,
        fetchImpl,
        timeoutMs: 1,
      }),
    ).rejects.toThrow(/timed out/)
  })
})

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function makeTarGz(entries: { body: string; name: string; type?: string }[]): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body)
    chunks.push(tarHeader(entry.name, body.length, entry.type ?? '0'))
    chunks.push(body)
    chunks.push(Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  chunks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(chunks))
}

function tarHeader(name: string, size: number, type: string): Buffer {
  const header = Buffer.alloc(512)
  writeTarString(header, name, 0, 100)
  writeTarOctal(header, 0o644, 100, 8)
  writeTarOctal(header, 0, 108, 8)
  writeTarOctal(header, 0, 116, 8)
  writeTarOctal(header, size, 124, 12)
  writeTarOctal(header, 0, 136, 12)
  header.fill(' ', 148, 156)
  header.write(type, 156, 1, 'ascii')
  header.write(`us${'tar'}\0`, 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  let checksum = 0
  for (const byte of header) checksum += byte
  writeTarOctal(header, checksum, 148, 8)
  return header
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value, offset, Math.min(length, Buffer.byteLength(value)), 'utf8')
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const raw = value.toString(8).padStart(length - 1, '0')
  header.write(`${raw}\0`, offset, length, 'ascii')
}
