import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSse } from '../src/sse.ts'

describe('parseSse', () => {
  it('returns undefined for empty / undefined input', () => {
    expect(parseSse(undefined)).toBeUndefined()
    expect(parseSse('')).toBeUndefined()
  })

  it('returns SSE-B2 for "B2"', () => {
    const r = parseSse('B2')
    expect(r?.mode).toBe('SSE-B2')
  })

  it('is case-insensitive for B2', () => {
    expect(parseSse('b2')?.mode).toBe('SSE-B2')
    expect(parseSse('  B2  ')?.mode).toBe('SSE-B2')
  })

  it('parses an SSE-C key and computes its MD5', () => {
    const raw = randomBytes(32)
    const b64 = raw.toString('base64')
    const r = parseSse(`C:${b64}`)
    expect(r?.mode).toBe('SSE-C')
    if (r?.mode === 'SSE-C') {
      expect(Buffer.from(r.customerKey, 'base64').equals(raw)).toBe(true)
      // MD5 is base64 16 bytes → 24 chars with `=` padding.
      expect(r.customerKeyMd5).toMatch(/^[A-Za-z0-9+/]{22}==$/)
    }
  })

  it('rejects an SSE-C key of the wrong length', () => {
    const tooShort = Buffer.alloc(16).toString('base64')
    expect(() => parseSse(`C:${tooShort}`)).toThrow(/exactly 32 bytes/)
  })

  it('rejects SSE-C base64 with non-canonical padding bits', () => {
    const key = Buffer.alloc(32, 0xff)
    const canonical = key.toString('base64')
    const nonCanonical = `${canonical.slice(0, -2)}9=`

    expect(Buffer.from(nonCanonical, 'base64').equals(key)).toBe(true)
    expect(nonCanonical).not.toBe(canonical)
    expect(() => parseSse(`C:${nonCanonical}`)).toThrow(/valid canonical base64/)
  })

  it('rejects an empty SSE-C key value', () => {
    expect(() => parseSse('C:')).toThrow(/empty/)
  })

  it('rejects an unknown SSE value', () => {
    expect(() => parseSse('AES256')).toThrow(/Expected "B2"/)
  })

  it('rejects SSE-B2 when parsing a source SSE-C key', () => {
    expect(() => parseSse('B2', { inputName: 'source-sse', allowB2: false })).toThrow(
      /Invalid 'source-sse' input/,
    )
  })
})
