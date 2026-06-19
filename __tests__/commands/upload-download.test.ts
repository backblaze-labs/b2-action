import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProgressEvent } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadCommand } from '../../src/commands/download.ts'
import { uploadCommand } from '../../src/commands/upload.ts'
import type { ParsedInputs } from '../../src/inputs.ts'
import { makeFixture, makeInputs, makeMultipartFixture, type TestFixture } from '../_helpers.ts'

function baseInputs(): ParsedInputs {
  return makeInputs('upload')
}

const MULTIPART_ABORT_REASON = 'test abort after multipart progress'

describe('upload + download commands (B2Simulator)', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-test')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('uploads a single file and reports a fileId', async () => {
    const local = join(fx.workDir, 'hello.txt')
    await writeFile(local, 'hello world')

    const result = await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.fileName).toBe('hello.txt')
    expect(result.files[0]?.fileId).toBeTruthy()
    expect(result.bytesTransferred).toBe(11)
  })

  it('uploads to an explicit destination key', async () => {
    const local = join(fx.workDir, 'report.csv')
    await writeFile(local, 'a,b,c\n')

    const result = await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'releases/v1/report.csv',
    })

    expect(result.files[0]?.fileName).toBe('releases/v1/report.csv')
  })

  it('treats destination as a prefix for a directory resolving to one file', async () => {
    const srcDir = join(fx.workDir, 'single-file-dir')
    await mkdir(srcDir)
    await writeFile(join(srcDir, 'data.bin'), 'payload')

    const result = await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: srcDir,
      destination: 'out.bin',
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.fileName).toBe('out.bin/data.bin')
  })

  it('round-trips bytes via upload → download', async () => {
    const local = join(fx.workDir, 'random.bin')
    const payload = randomBytes(64 * 1024)
    await writeFile(local, payload)

    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'random.bin',
    })

    const outPath = join(fx.workDir, 'downloaded.bin')
    const downloaded = await downloadCommand(fx.bucket, {
      ...baseInputs(),
      action: 'download',
      source: 'random.bin',
      destination: outPath,
    })

    expect(downloaded.files).toHaveLength(1)
    const got = await readFile(outPath)
    expect(got.equals(payload)).toBe(true)
  })

  it('downloads every file under a prefix', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const local = join(fx.workDir, name)
      await writeFile(local, `payload-${name}`)
      await uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: local,
        destination: `bundle/${name}`,
      })
    }

    const destDir = join(fx.workDir, 'out')
    const result = await downloadCommand(fx.bucket, {
      ...baseInputs(),
      action: 'download',
      source: 'bundle/',
      destination: destDir,
    })

    expect(result.files).toHaveLength(3)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      const got = await readFile(join(destDir, name), 'utf8')
      expect(got).toBe(`payload-${name}`)
    }
  })

  it('uploads glob matches with bounded file-level concurrency', async () => {
    const srcDir = join(fx.workDir, 'bundle')
    await mkdir(srcDir)
    for (const name of ['c.txt', 'a.txt', 'b.txt']) {
      await writeFile(join(srcDir, name), `payload-${name}`)
    }

    let active = 0
    let maxActive = 0
    const partConcurrencyValues: Array<number | undefined> = []
    const originalUpload = fx.bucket.upload.bind(fx.bucket)
    fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
      partConcurrencyValues.push(args[0].concurrency)
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 25))
      try {
        return await originalUpload(...args)
      } finally {
        active--
      }
    }

    const result = await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: srcDir,
      concurrency: 2,
    })

    expect(result.files.map((file) => file.fileName)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(result.bytesTransferred).toBe('payload-a.txt'.length * 3)
    expect(maxActive).toBe(2)
    expect(partConcurrencyValues).toEqual([1, 1, 1])
  })

  it('uses concurrency as multipart part concurrency for explicit single-file uploads', async () => {
    const local = join(fx.workDir, 'large.bin')
    await writeFile(local, randomBytes(256 * 1024))

    let partConcurrency: number | undefined
    const originalUpload = fx.bucket.upload.bind(fx.bucket)
    fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
      partConcurrency = args[0].concurrency
      return await originalUpload(...args)
    }

    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      concurrency: 3,
    })

    expect(partConcurrency).toBe(3)
  })

  it('uses concurrency as multipart part concurrency when a directory resolves to one file', async () => {
    const srcDir = join(fx.workDir, 'single-file-bundle')
    await mkdir(srcDir)
    await writeFile(join(srcDir, 'large.bin'), randomBytes(256 * 1024))

    let partConcurrency: number | undefined
    const originalUpload = fx.bucket.upload.bind(fx.bucket)
    fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
      partConcurrency = args[0].concurrency
      return await originalUpload(...args)
    }

    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: srcDir,
      concurrency: 3,
    })

    expect(partConcurrency).toBe(3)
  })

  it('waits for active glob uploads before rethrowing the first failure', async () => {
    const srcDir = join(fx.workDir, 'failing-bundle')
    await mkdir(srcDir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(srcDir, name), `payload-${name}`)
    }

    const started: string[] = []
    const completed: string[] = []
    const originalUpload = fx.bucket.upload.bind(fx.bucket)
    fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
      const fileName = args[0].fileName
      started.push(fileName)
      if (fileName === 'b.txt') {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const result = await originalUpload(...args)
      completed.push(fileName)
      if (fileName === 'a.txt') {
        throw new Error('upload failed')
      }
      return result
    }

    await expect(
      uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: srcDir,
        concurrency: 2,
      }),
    ).rejects.toThrow('upload failed')

    expect(started).toHaveLength(2)
    expect(started).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
    expect(completed).toHaveLength(2)
    expect(completed).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
  })

  it('rethrows undefined glob upload failures', async () => {
    const srcDir = join(fx.workDir, 'undefined-failure-bundle')
    await mkdir(srcDir)
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(srcDir, name), `payload-${name}`)
    }

    const started: string[] = []
    const originalUpload = fx.bucket.upload.bind(fx.bucket)
    fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
      const fileName = args[0].fileName
      started.push(fileName)
      if (fileName === 'a.txt') {
        throw undefined
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
      return await originalUpload(...args)
    }

    let rejected = false
    try {
      await uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: srcDir,
        concurrency: 2,
      })
    } catch (error) {
      rejected = true
      expect(error).toBeUndefined()
    }

    expect(rejected).toBe(true)
    expect(started).toHaveLength(2)
    expect(started).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
  })

  it('fails when an upload glob matches no files and fail-on-empty is true', async () => {
    await expect(
      uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: join(fx.workDir, 'does-not-exist-*.txt'),
      }),
    ).rejects.toThrow(/No files matched/)
  })

  it('continues when fail-on-empty is false', async () => {
    const result = await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: join(fx.workDir, 'does-not-exist-*.txt'),
      failOnEmpty: false,
    })
    expect(result.files).toHaveLength(0)
    expect(result.bytesTransferred).toBe(0)
  })
})

describe('upload: multipart abort cleanup', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeMultipartFixture('gh-action-upload-abort-cleanup')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('cancels an unfinished multipart upload when the signal aborts after progress', async () => {
    const local = join(fx.workDir, 'abort-large.bin')
    await writeFile(local, randomBytes(256 * 1024))

    const controller = new AbortController()
    const sawMultipartProgress = abortOnMultipartProgress(fx, controller)

    await expect(
      uploadCommand(
        fx.bucket,
        makeInputs('upload', fx, {
          source: local,
          destination: 'abort-large.bin',
        }),
        controller.signal,
      ),
    ).rejects.toThrow(MULTIPART_ABORT_REASON)

    const unfinished = await fx.bucket.listUnfinishedLargeFiles({
      namePrefix: 'abort-large.bin',
    })
    expect(sawMultipartProgress()).toBe(true)
    expect(unfinished.files).toHaveLength(0)
  })
})

function abortOnMultipartProgress(fx: TestFixture, controller: AbortController): () => boolean {
  const originalUpload = fx.bucket.upload.bind(fx.bucket)
  let sawMultipartProgress = false
  // Permanently replaces this test's bucket.upload. This is safe because
  // makeMultipartFixture() creates a fresh bucket for each beforeEach.
  fx.bucket.upload = async (...args: Parameters<typeof fx.bucket.upload>) => {
    const [options] = args
    return await originalUpload({
      ...options,
      onProgress: (event: ProgressEvent) => {
        options.onProgress?.(event)
        if (!sawMultipartProgress && event.totalParts !== null && event.bytesTransferred > 0) {
          sawMultipartProgress = true
          controller.abort(new Error(MULTIPART_ABORT_REASON))
        }
      },
    })
  }
  return () => sawMultipartProgress
}
