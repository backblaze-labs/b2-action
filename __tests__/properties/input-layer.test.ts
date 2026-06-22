import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLocalPath } from '../../src/commands/download.ts'
import { type ResolvedFile, remapFileName } from '../../src/commands/upload.ts'
import { normalizeSha1 } from '../../src/commands/verify.ts'
import { parseBool, parseEnum, parseInputs, parsePositiveInt, splitCsv } from '../../src/inputs.ts'
import { parseSse } from '../../src/sse.ts'
import { captureStdout, resetInputEnv, setInput } from '../_helpers.ts'

const PROPERTY_PARAMS = { seed: 0xb2051, numRuns: 200 } as const
const BOOLEAN_SPELLINGS = new Map<string, boolean>([
  ['true', true],
  ['1', true],
  ['yes', true],
  ['false', false],
  ['0', false],
  ['no', false],
])
const HEX = [...'0123456789abcdef'] as const

describe('input layer properties', () => {
  beforeEach(() => {
    resetInputEnv()
    Reflect.deleteProperty(process.env, 'B2_APPLICATION_KEY_ID')
    Reflect.deleteProperty(process.env, 'B2_APPLICATION_KEY')
  })

  afterEach(resetInputEnv)

  it('round-trips any 32-byte SSE-C key and computes its MD5', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (bytes) => {
        const key = Buffer.from(bytes)
        const parsed = parseSse(`C:${key.toString('base64')}`)

        expect(parsed?.mode).toBe('SSE-C')
        if (parsed?.mode !== 'SSE-C') throw new Error('expected SSE-C setting')
        expect(Buffer.from(parsed.customerKey, 'base64').equals(key)).toBe(true)
        expect(parsed.customerKeyMd5).toBe(createHash('md5').update(key).digest('base64'))
      }),
      PROPERTY_PARAMS,
    )
  })

  it('rejects non-32-byte SSE-C keys with a clear error', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 0, maxLength: 64 }).filter((bytes) => bytes.length !== 32),
        (bytes) => {
          const encoded = Buffer.from(bytes).toString('base64')
          expect(() => parseSse(`C:${encoded}`)).toThrow(/SSE-C key/)
        },
      ),
      PROPERTY_PARAMS,
    )
  })

  it('rejects malformed SSE-C base64 before decoding', () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 32, maxLength: 32 }),
        fc.integer({ min: 0, max: 44 }),
        (bytes, offset) => {
          const encoded = Buffer.from(bytes).toString('base64')
          const malformed = `${encoded.slice(0, offset)}!${encoded.slice(offset)}`
          expect(() => parseSse(`C:${malformed}`)).toThrow(/valid canonical base64/)
        },
      ),
      PROPERTY_PARAMS,
    )
  })

  it('splits CSV inputs without empty or untrimmed entries', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const parts = splitCsv(raw)

        expect(parts).toEqual(
          raw
            .split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0),
        )
        expect(parts.every((part) => part.length > 0 && part === part.trim())).toBe(true)
      }),
      PROPERTY_PARAMS,
    )
  })

  it('accepts only documented enum values', () => {
    const valid = ['upload', 'download', 'sync'] as const
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        if ((valid as readonly string[]).includes(raw)) {
          expect(parseEnum('action', raw, valid)).toBe(raw)
        } else {
          expect(() => parseEnum('action', raw, valid)).toThrow(/Must be one of/)
        }
      }),
      PROPERTY_PARAMS,
    )
  })

  it('accepts only documented boolean spellings', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (raw) => {
        const normalized = raw.trim().toLowerCase()
        const expected = BOOLEAN_SPELLINGS.get(normalized)
        if (expected !== undefined) {
          expect(parseBool('dry-run', raw)).toBe(expected)
        } else {
          expect(() => parseBool('dry-run', raw)).toThrow(/Invalid boolean/)
        }
      }),
      PROPERTY_PARAMS,
    )
  })

  it('accepts only safe positive decimal integers', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const trimmed = raw.trim()
        const expected = Number(trimmed)
        if (/^\d+$/.test(trimmed) && expected > 0 && Number.isSafeInteger(expected)) {
          expect(parsePositiveInt('concurrency', raw)).toBe(expected)
        } else {
          expect(() => parsePositiveInt('concurrency', raw)).toThrow(/positive integer/)
        }
      }),
      PROPERTY_PARAMS,
    )
  })

  it('keeps credential input values ahead of environment fallbacks', async () => {
    const credential = fc.stringMatching(/^[A-Za-z0-9_-]{1,24}$/)

    await fc.assert(
      fc.asyncProperty(
        credential,
        credential,
        credential,
        credential,
        async (id, key, envId, envKey) => {
          resetInputEnv()
          process.env.B2_APPLICATION_KEY_ID = envId
          process.env.B2_APPLICATION_KEY = envKey
          setInput('action', 'upload')
          setInput('application-key-id', id)
          setInput('application-key', key)
          setInput('bucket', 'bucket')

          await captureStdout(() => {
            const parsed = parseInputs()
            expect(parsed.applicationKeyId).toBe(id)
            expect(parsed.applicationKey).toBe(key)
          })
        },
      ),
      PROPERTY_PARAMS,
    )
  })
})

describe('path and checksum properties', () => {
  it('remaps upload names without rewriting opaque B2 key separators', () => {
    fc.assert(
      fc.property(
        fc.record<ResolvedFile>({
          localPath: fc.constant('/tmp/source'),
          fileName: fc.string({ maxLength: 120 }),
        }),
        fc.option(fc.string({ maxLength: 120 }), { nil: undefined }),
        fc.boolean(),
        (file, destination, isSingleExplicitFile) => {
          const mapped = remapFileName(file, destination, isSingleExplicitFile)

          expect(mapped).toBe(expectedRemappedFileName(file, destination, isSingleExplicitFile))
          if (destination === undefined || destination === '') return

          const normalizedDestination = destination.replace(/\/+$/g, '')
          const exactSingleDestination = isSingleExplicitFile && !destination.endsWith('/')
          if (normalizedDestination !== '' && !exactSingleDestination) {
            expect(hasB2Prefix(mapped, normalizedDestination)).toBe(true)
          }
        },
      ),
      PROPERTY_PARAMS,
    )
  })

  it('is stable under trailing destination slashes in prefix mode', () => {
    fc.assert(
      fc.property(
        fc.record<ResolvedFile>({
          localPath: fc.constant('/tmp/source'),
          fileName: fc.string({ maxLength: 120 }),
        }),
        fc.string({ maxLength: 120 }),
        fc.boolean(),
        (file, destination, isSingleExplicitFile) => {
          fc.pre(destination.replace(/\/+$/g, '').length > 0)
          const prefixDestination = `${destination.replace(/\/+$/g, '')}/`

          if (isSingleExplicitFile) {
            expect(remapFileName(file, prefixDestination, true)).toBe(
              remapFileName(file, `${prefixDestination}///`, true),
            )
          } else {
            expect(remapFileName(file, destination, false)).toBe(
              remapFileName(file, prefixDestination, false),
            )
          }
        },
      ),
      PROPERTY_PARAMS,
    )
  })

  it('preserves double slashes and leading slashes in B2 upload keys', () => {
    const file = { localPath: '/tmp/source', fileName: '/source//name.txt' }

    expect(remapFileName(file, '//dest//prefix///', false)).toBe('//dest//prefix//source//name.txt')
    expect(remapFileName(file, '//exact//key.txt', true)).toBe('//exact//key.txt')
  })

  it('resolves arbitrary B2 keys under destination directories', async () => {
    const destRoot = resolve(join(tmpdir(), 'b2-action-property-download-root'))

    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 160 }), async (key) => {
        if (isMappableSingleFileDownloadKey(key)) {
          const localPath = await resolveLocalPath(key, `${destRoot}${sep}`)
          expectPathInside(destRoot, localPath)
        } else {
          await expect(resolveLocalPath(key, `${destRoot}${sep}`)).rejects.toThrow(
            /cannot be safely mapped/,
          )
        }
      }),
      PROPERTY_PARAMS,
    )
  })

  it('single-file downloads validate only the basename used as the local file', async () => {
    const destRoot = resolve(join(tmpdir(), 'b2-action-single-download-root'))

    await expect(resolveLocalPath('a//b.txt', `${destRoot}${sep}`)).resolves.toBe(
      resolve(destRoot, 'b.txt'),
    )
    await expect(resolveLocalPath('a/../b.txt', `${destRoot}${sep}`)).resolves.toBe(
      resolve(destRoot, 'b.txt'),
    )
    await expect(resolveLocalPath('bad-parent\u0000/good.txt', `${destRoot}${sep}`)).resolves.toBe(
      resolve(destRoot, 'good.txt'),
    )
    await expect(resolveLocalPath('a//', `${destRoot}${sep}`)).rejects.toThrow(
      /cannot be safely mapped/,
    )
  })

  it('keeps adversarial B2 keys inside the destination directory', async () => {
    const destRoot = resolve(join(tmpdir(), 'b2-action-adversarial-download-root'))
    const keys = [
      '../escape.txt',
      '..',
      './dot.txt',
      'a//b.txt',
      'a/../b.txt',
      'a/../../escape.txt',
      'a\\..\\escape.txt',
      'nested//name.txt',
      '\0bad.txt',
      'unicode/\u202e.txt',
    ]

    for (const key of keys) {
      if (isMappableSingleFileDownloadKey(key)) {
        const localPath = await resolveLocalPath(key, `${destRoot}${sep}`)
        expectPathInside(destRoot, localPath)
      } else {
        await expect(resolveLocalPath(key, `${destRoot}${sep}`)).rejects.toThrow(
          /cannot be safely mapped/,
        )
      }
    }
  })

  it('preserves legal POSIX download names that used to collide under lossy sanitizing', async () => {
    const destRoot = resolve(join(tmpdir(), 'b2-action-posix-download-root'))
    const keys = [
      'release/bin/deploy_.sh',
      'release/bin/deploy|.sh',
      'bundle/a/b.txt',
      'bundle/a\\b.txt',
      'archive.',
      'archive ',
      '..foo',
      'nested/..foo',
      'CON',
      'aux.txt',
      'data:2024.json',
      'report?.csv',
    ]

    for (const key of keys) {
      if (process.platform === 'win32' && !isMappableSingleFileDownloadKey(key)) {
        await expect(resolveLocalPath(key, `${destRoot}${sep}`)).rejects.toThrow(
          /cannot be safely mapped/,
        )
        continue
      }

      const localPath = await resolveLocalPath(key, `${destRoot}${sep}`)
      expectPathInside(destRoot, localPath)
      if (process.platform !== 'win32') {
        expect(localPath.endsWith(key.split('/').at(-1) ?? '')).toBe(true)
      }
    }
  })

  it('normalizes valid SHA-1 digests before comparison', () => {
    const sha1 = fc
      .array(fc.constantFrom(...HEX), { minLength: 40, maxLength: 40 })
      .map((chars) => chars.join(''))

    fc.assert(
      fc.property(sha1, (digest) => {
        expect(normalizeSha1(` ${digest.toUpperCase()} `)).toBe(digest)
      }),
      PROPERTY_PARAMS,
    )
  })

  it('rejects malformed SHA-1 digests cleanly', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 100 }).filter((raw) => !/^[a-f0-9]{40}$/i.test(raw.trim())),
        (raw) => {
          expect(() => normalizeSha1(raw)).toThrow(/40-character hexadecimal SHA-1/)
        },
      ),
      PROPERTY_PARAMS,
    )
  })
})

function expectedRemappedFileName(
  file: ResolvedFile,
  destination: string | undefined,
  isSingleExplicitFile: boolean,
): string {
  if (destination === undefined || destination === '') return file.fileName
  const dest = destination.replace(/\/+$/g, '')
  if (isSingleExplicitFile && !destination.endsWith('/')) return dest
  return `${dest}/${file.fileName}`
}

function hasB2Prefix(value: string, prefix: string): boolean {
  return value === prefix || value.startsWith(`${prefix}/`)
}

function isMappableSingleFileDownloadKey(key: string): boolean {
  const tail = key.split('/').at(-1) ?? ''
  if (tail === '' || tail === '.' || tail === '..') return false
  if ([...tail].some((char) => (char.codePointAt(0) ?? 0) <= 0x1f)) return false
  return process.platform !== 'win32' || !isUnsafeWindowsSegment(tail)
}

function isUnsafeWindowsSegment(segment: string): boolean {
  return (
    /[<>:"|?*\\]/u.test(segment) ||
    /[. ]$/u.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
  )
}

function expectPathInside(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  expect(rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))).toBe(true)
}
