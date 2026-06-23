import type { ProgressEvent } from '@backblaze-labs/b2-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeProgressListener } from '../src/progress.ts'

/**
 * @actions/core.info() writes via `process.stdout.write`. Spy on that so we
 * can observe the formatted progress lines.
 */
function captureStdout(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const original = process.stdout.write.bind(process.stdout) as typeof process.stdout.write
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const text =
        typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8')
      lines.push(text)
      void original
      void rest
      return true
    })
  return { lines, restore: () => spy.mockRestore() }
}

function event(over: Partial<ProgressEvent> = {}): ProgressEvent {
  return {
    bytesTransferred: 0,
    totalBytes: 100,
    partsCompleted: 0,
    totalParts: null,
    elapsedMs: 0,
    ...over,
  }
}

describe('makeProgressListener', () => {
  it('emits the first event', () => {
    const { lines, restore } = captureStdout()
    try {
      const listener = makeProgressListener('test', 60_000)
      listener(event({ bytesTransferred: 0, totalBytes: 100 }))
      const text = lines.join('')
      expect(text).toContain('test')
      expect(text).toContain('MB/s')
    } finally {
      restore()
    }
  })

  it('emits the final event (bytesTransferred >= totalBytes) even when throttled', () => {
    const { lines, restore } = captureStdout()
    try {
      const listener = makeProgressListener('label', 60_000)
      listener(event({ bytesTransferred: 0, totalBytes: 100 }))
      listener(event({ bytesTransferred: 50, totalBytes: 100 }))
      listener(event({ bytesTransferred: 100, totalBytes: 100 }))
      const text = lines.join('')
      expect(text).toContain('100%')
    } finally {
      restore()
    }
  })

  it('throttles intermediate events', () => {
    const { lines, restore } = captureStdout()
    try {
      const listener = makeProgressListener('throttled', 60_000)
      for (let i = 0; i < 20; i++) {
        listener(event({ bytesTransferred: i * 10, totalBytes: 1000 }))
      }
      const lineCount = lines
        .join('')
        .split('\n')
        .filter((l) => l.includes('throttled')).length
      expect(lineCount).toBeLessThan(20)
    } finally {
      restore()
    }
  })

  it('handles unknown totalBytes (null) without crashing', () => {
    const listener = makeProgressListener('test', 0)
    listener(event({ bytesTransferred: 1024, totalBytes: null }))
  })

  it('includes parts info when totalParts is set', () => {
    const { lines, restore } = captureStdout()
    try {
      const listener = makeProgressListener('multipart', 0)
      listener(
        event({
          bytesTransferred: 5_000_000,
          totalBytes: 10_000_000,
          totalParts: 2,
          partsCompleted: 1,
        }),
      )
      const text = lines.join('')
      expect(text).toContain('1/2 parts')
    } finally {
      restore()
    }
  })
})

describe('makeProgressListener: precise output + math', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('formats the exact percent and total suffix for a known event', () => {
    const { lines, restore } = captureStdout()
    try {
      makeProgressListener(
        'up',
        0,
      )(event({ bytesTransferred: 10, totalBytes: 100, totalParts: null }))
      const text = lines.join('')
      expect(text).toContain('up 10%')
      expect(text).toContain('/ 100 B')
    } finally {
      restore()
    }
  })

  it('shows ?% and omits the total suffix when totalBytes is null', () => {
    const { lines, restore } = captureStdout()
    try {
      makeProgressListener('up', 0)(event({ bytesTransferred: 10, totalBytes: null }))
      const text = lines.join('')
      expect(text).toContain('up ?%')
      expect(text).not.toMatch(/\/ \d/)
    } finally {
      restore()
    }
  })

  it('omits the parts suffix when totalParts is null', () => {
    const { lines, restore } = captureStdout()
    try {
      makeProgressListener(
        'np',
        0,
      )(event({ bytesTransferred: 10, totalBytes: 100, totalParts: null }))
      expect(lines.join('')).not.toContain('parts)')
    } finally {
      restore()
    }
  })

  it('skips an intermediate not-due event but still emits the first', () => {
    const { lines, restore } = captureStdout()
    try {
      const listener = makeProgressListener('thr', 100_000)
      listener(event({ bytesTransferred: 1, totalBytes: 100 }))
      listener(event({ bytesTransferred: 2, totalBytes: 100 }))
      const count = lines
        .join('')
        .split('\n')
        .filter((l) => l.includes('thr')).length
      expect(count).toBe(1)
    } finally {
      restore()
    }
  })

  it('computes MB/s from the byte delta over elapsed time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(500) // listener captures lastTime = 500
    const listener = makeProgressListener('rate', 0)
    vi.setSystemTime(1500) // elapsed = 1000ms
    const { lines, restore } = captureStdout()
    try {
      listener(event({ bytesTransferred: 1024 * 1024, totalBytes: null }))
      expect(lines.join('')).toContain('@ 1.00 MB/s')
    } finally {
      restore()
    }
  })
})
