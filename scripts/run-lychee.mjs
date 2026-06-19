#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const LYCHEE_VERSION = '0.23.0'
const LYCHEE_TAG = `lychee-v${LYCHEE_VERSION}`
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

const PLATFORM_ASSETS = {
  'darwin-arm64': { archive: true, name: 'lychee-arm64-macos.tar.gz' },
  'linux-arm64': { archive: true, name: 'lychee-aarch64-unknown-linux-gnu.tar.gz' },
  'linux-x64': { archive: true, name: 'lychee-x86_64-unknown-linux-gnu.tar.gz' },
  'win32-x64': { archive: false, name: 'lychee-x86_64-windows.exe' },
}

const cacheRoot = process.env.LYCHEE_CACHE_DIR ?? join(REPO, 'node_modules', '.cache', 'lychee')
const platformKey = `${process.platform}-${process.arch}`
const toolDir = join(cacheRoot, LYCHEE_TAG, platformKey)
const binaryName = process.platform === 'win32' ? 'lychee.exe' : 'lychee'
const binaryPath = join(toolDir, binaryName)

if (!binaryMatchesVersion(binaryPath)) {
  await installLychee(binaryPath)
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  cwd: REPO,
  env: process.env,
  stdio: 'inherit',
})

if (result.error !== undefined) {
  throw result.error
}

process.exit(result.status ?? 1)

function binaryMatchesVersion(path) {
  if (!existsSync(path)) return false
  const result = spawnSync(path, ['--version'], { encoding: 'utf8' })
  const output = `${result.stdout}${result.stderr}`
  return result.status === 0 && output.includes(LYCHEE_VERSION)
}

async function installLychee(destination) {
  const asset = assetForCurrentPlatform()
  const url = `https://github.com/lycheeverse/lychee/releases/download/${LYCHEE_TAG}/${asset.name}`
  const downloadDir = join(toolDir, 'download')
  const downloadPath = join(downloadDir, asset.name)

  rmSync(toolDir, { force: true, recursive: true })
  mkdirSync(downloadDir, { recursive: true })

  console.error(`Downloading lychee ${LYCHEE_VERSION} from ${url}`)
  await download(url, downloadPath)

  mkdirSync(dirname(destination), { recursive: true })
  if (asset.archive) {
    extractArchive(downloadPath, downloadDir)
    renameSync(join(downloadDir, 'lychee'), destination)
  } else {
    copyFileSync(downloadPath, destination)
  }

  chmodSync(destination, 0o755)
  rmSync(downloadDir, { force: true, recursive: true })

  if (!binaryMatchesVersion(destination)) {
    throw new Error(`Downloaded lychee binary did not report version ${LYCHEE_VERSION}`)
  }
}

function assetForCurrentPlatform() {
  const asset = PLATFORM_ASSETS[platformKey]
  if (asset !== undefined) return asset

  const supported = Object.keys(PLATFORM_ASSETS).sort().join(', ')
  throw new Error(
    `No pinned ${LYCHEE_TAG} binary is available for ${platformKey}. ` +
      `Supported platforms: ${supported}.`,
  )
}

async function download(url, destination) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'backblaze-labs/b2-action docs:links' },
  })
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

function extractArchive(archivePath, destinationDir) {
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destinationDir], {
    encoding: 'utf8',
  })
  if (result.error !== undefined) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr || result.stdout}`)
  }
}
