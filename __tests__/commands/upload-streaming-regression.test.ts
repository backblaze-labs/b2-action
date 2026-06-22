import { rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ProgressEvent } from '@backblaze-labs/b2-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TestFixture } from '../_helpers.ts'

const CONCURRENCY = 4
const CHUNK_SIZE = 16 * 1024

describe('upload streaming regression', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('keeps large upload stream intake bounded by part concurrency', async () => {
    const intake = new IntakeTracker()
    let totalSize = 0
    let observedCanSlice: boolean | undefined
    let observedSourceSize: number | undefined

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        createReadStream: vi.fn(() => makeSyntheticReadable(totalSize, CHUNK_SIZE, intake)),
      }
    })

    // Import the module under test first, after the fs mock is registered.
    // _helpers.ts also imports uploadCommand at module scope.
    const { uploadCommand } = await import('../../src/commands/upload.ts')
    const { makeInputs, makeMultipartFixture, MULTIPART_PART_SIZE } = await import('../_helpers.ts')
    const partSize = MULTIPART_PART_SIZE
    totalSize = partSize * 24 + 123
    const fx: TestFixture = await makeMultipartFixture('gh-action-streaming-regression')
    const local = join(fx.workDir, 'synthetic-large.bin')

    try {
      await writeFile(local, '')
      await truncate(local, totalSize)

      const originalUpload = fx.bucket.upload.bind(fx.bucket)
      // Intentionally inspect the SDK upload boundary: this is where the
      // action hands its StreamSource to the SDK, and the non-sliceable source
      // contract has no higher-level observable signal.
      fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
        const [options] = args
        observedCanSlice = options.source.canSlice
        observedSourceSize = options.source.size
        return await originalUpload({
          ...options,
          onProgress: (event: ProgressEvent) => {
            options.onProgress?.(event)
            intake.markUploadedThrough(event.bytesTransferred)
          },
        })
      }

      const result = await uploadCommand(
        fx.bucket,
        makeInputs('upload', fx, {
          source: local,
          concurrency: CONCURRENCY,
          partSize,
        }),
      )

      // The SDK owns multipart buffering, so this test verifies two action-
      // layer invariants: uploadCommand passes a forward-only StreamSource,
      // and the simulator upload never reads substantially beyond the bytes
      // already accepted as uploaded. A full stream buffer would make the peak
      // approach totalSize before the first multipart progress event. If this
      // numeric bound fails after an SDK upgrade, triage SDK prefetch behavior
      // first; the canSlice assertion is the SDK-version-independent guard.
      const bound = CONCURRENCY * partSize + CHUNK_SIZE * 8
      expect(result.bytesTransferred).toBe(totalSize)
      expect(observedCanSlice).toBe(false)
      expect(observedSourceSize).toBe(totalSize)
      expect(intake.produced).toBe(totalSize)
      expect(intake.peakProducedAheadOfUpload).toBeLessThanOrEqual(bound)
      expect(totalSize).toBeGreaterThan(bound * 4)
    } finally {
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })
})

class IntakeTracker {
  produced = 0
  private uploaded = 0
  peakProducedAheadOfUpload = 0

  markProduced(bytes: number): void {
    this.produced += bytes
    this.updatePeak()
  }

  markUploadedThrough(cumulativeBytesTransferred: number): void {
    this.uploaded = Math.max(this.uploaded, cumulativeBytesTransferred)
    this.updatePeak()
  }

  private updatePeak(): void {
    this.peakProducedAheadOfUpload = Math.max(
      this.peakProducedAheadOfUpload,
      this.produced - this.uploaded,
    )
  }
}

function makeSyntheticReadable(
  totalSize: number,
  chunkSize: number,
  intake: IntakeTracker,
): Readable {
  let offset = 0
  return new Readable({
    highWaterMark: chunkSize,
    read() {
      if (offset >= totalSize) {
        this.push(null)
        return
      }

      const length = Math.min(chunkSize, totalSize - offset)
      const chunk = Buffer.alloc(length, offset % 256)
      offset += length
      intake.markProduced(length)
      this.push(chunk)
    },
  })
}
