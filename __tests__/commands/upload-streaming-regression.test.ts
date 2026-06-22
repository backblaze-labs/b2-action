import { rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { B2Client, type Bucket, type ProgressEvent } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeParsedInputs,
  TEST_APPLICATION_KEY,
  TEST_APPLICATION_KEY_ID,
} from '../_parsed-inputs.ts'

const PART_SIZE = 100_000
const CONCURRENCY = 4
const CHUNK_SIZE = 16 * 1024
const TOTAL_SIZE = PART_SIZE * 24 + 123

describe('upload streaming regression', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  it('keeps large upload stream intake bounded by part concurrency', async () => {
    const fx = await makeMultipartFixture('gh-action-streaming-regression')
    const local = join(fx.workDir, 'synthetic-large.bin')
    await writeFile(local, '')
    await truncate(local, TOTAL_SIZE)
    const intake = new IntakeTracker()
    let observedCanSlice: boolean | undefined
    let observedSourceSize: number | undefined

    vi.resetModules()
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        createReadStream: vi.fn(() => makeSyntheticReadable(TOTAL_SIZE, CHUNK_SIZE, intake)),
      }
    })

    try {
      const { uploadCommand } = await import('../../src/commands/upload.ts')
      const originalUpload = fx.bucket.upload.bind(fx.bucket)
      fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
        const [options] = args
        observedCanSlice = options.source.canSlice
        observedSourceSize = options.source.size
        return await originalUpload({
          ...options,
          onProgress: (event: ProgressEvent) => {
            options.onProgress?.(event)
            intake.markUploaded(event.bytesTransferred)
          },
        })
      }

      const result = await uploadCommand(fx.bucket, {
        ...makeParsedInputs('upload', {
          bucket: fx.bucket.name,
          source: local,
          concurrency: CONCURRENCY,
          partSize: PART_SIZE,
        }),
      })

      // The SDK owns multipart buffering, so this test verifies two action-
      // layer invariants: uploadCommand passes a forward-only StreamSource,
      // and the simulator upload never reads substantially beyond the bytes
      // already accepted as uploaded. A full stream buffer would make the peak
      // approach TOTAL_SIZE before the first multipart progress event.
      const bound = CONCURRENCY * PART_SIZE + CHUNK_SIZE * 8
      expect(result.bytesTransferred).toBe(TOTAL_SIZE)
      expect(observedCanSlice).toBe(false)
      expect(observedSourceSize).toBe(TOTAL_SIZE)
      expect(intake.produced).toBe(TOTAL_SIZE)
      expect(intake.peakProducedAheadOfUpload).toBeLessThanOrEqual(bound)
      expect(TOTAL_SIZE).toBeGreaterThan(bound * 4)
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

  markUploaded(bytes: number): void {
    this.uploaded = Math.max(this.uploaded, bytes)
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

interface MultipartFixture {
  workDir: string
  bucket: Bucket
}

async function makeMultipartFixture(bucketName: string): Promise<MultipartFixture> {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const sim = new B2Simulator({
    minimumPartSize: PART_SIZE,
    recommendedPartSize: PART_SIZE,
  })
  const client = new B2Client({
    applicationKeyId: TEST_APPLICATION_KEY_ID,
    applicationKey: TEST_APPLICATION_KEY,
    transport: sim.transport(),
  })
  await client.authorize()
  const bucket = await client.createBucket({ bucketName, bucketType: 'allPrivate' })
  const workDir = await mkdtemp(join(tmpdir(), 'b2-streaming-test-'))
  return { workDir, bucket }
}
