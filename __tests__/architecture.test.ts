import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Structural gate for the boundary invariants documented in ARCHITECTURE.md:
// the SDK is the single provider boundary for B2 I/O, and the dispatcher
// (main.ts) owns outputs while commands only return typed results. These tests
// make those edges self-enforcing rather than review-enforced (see TD-0004).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(repoRoot, 'src')

// Importing any of these would mean the action talks to B2 (or a subprocess)
// itself instead of going through @backblaze-labs/b2-sdk.
const FORBIDDEN_MODULES = [
  'node:http',
  'node:https',
  'node:http2',
  'node:net',
  'node:tls',
  'node:dgram',
  'node:child_process',
  'undici',
  'node-fetch',
  'axios',
  'got',
]

const forbiddenImport = new RegExp(
  `from '(${FORBIDDEN_MODULES.map(escapeRegExp).join('|')})'|` +
    `require\\('(${FORBIDDEN_MODULES.map(escapeRegExp).join('|')})'\\)`,
)

describe('architecture boundary invariants', () => {
  it('routes all B2 and process I/O through the SDK, never raw transport', async () => {
    const offenders: string[] = []
    for (const file of await collectSource(srcDir)) {
      const code = stripComments(await readFile(file, 'utf8'))
      const rel = relative(repoRoot, file)
      const forbidden = forbiddenImport.exec(code)
      if (forbidden !== null) offenders.push(`${rel} imports ${forbidden[1] ?? forbidden[2]}`)
      if (/\bfetch\s*\(/.test(code)) offenders.push(`${rel} calls fetch() directly`)
    }
    expect(offenders).toEqual([])
  })

  it('keeps output writes in the dispatcher, never in a command', async () => {
    const offenders: string[] = []
    for (const file of await collectSource(join(srcDir, 'commands'))) {
      const code = stripComments(await readFile(file, 'utf8'))
      if (code.includes('setOutput')) offenders.push(`${relative(repoRoot, file)} calls setOutput`)
    }
    expect(offenders).toEqual([])
  })

  it('never lets a command depend upward on the entrypoint or output layer', async () => {
    const offenders: string[] = []
    for (const file of await collectSource(join(srcDir, 'commands'))) {
      const code = await readFile(file, 'utf8')
      if (/from '\.\.\/(main|outputs)(\.ts)?'/.test(code)) {
        offenders.push(`${relative(repoRoot, file)} imports an upper layer`)
      }
    }
    expect(offenders).toEqual([])
  })
})

async function collectSource(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectSource(full)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
