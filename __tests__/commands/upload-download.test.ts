import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
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

  it('does not silently normalize SDK-rejected upload keys', async () => {
    const local = join(fx.workDir, 'opaque.txt')
    await writeFile(local, 'opaque')

    await expect(
      uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: local,
        destination: '//archive//opaque.txt',
      }),
    ).rejects.toThrow(/fileName/)
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

  it('does not collapse legal POSIX names during prefix downloads', async () => {
    const entries = [
      ['bundle/release/bin/deploy_.sh', 'underscore'],
      ['bundle/release/bin/deploy|.sh', 'pipe'],
      ['bundle/tools/tool*.sh', 'star'],
      ['bundle/tools/tool?.sh', 'question'],
      ['bundle/slash/a/b.txt', 'slash'],
      ['bundle/slash/a\\b.txt', 'backslash'],
      ['bundle/trailing/archive.', 'dot'],
      ['bundle/trailing/archive ', 'space'],
      ['bundle/dot-prefix/..foo', 'dot-prefix'],
      ['bundle/windows/CON', 'reserved'],
    ] as const

    for (const [fileName, body] of entries) {
      const local = join(fx.workDir, `${body}.txt`)
      await writeFile(local, body)
      await uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: local,
        destination: fileName,
      })
    }

    const destDir = join(fx.workDir, 'posix-out')
    if (process.platform === 'win32') {
      await expect(
        downloadCommand(fx.bucket, {
          ...baseInputs(),
          action: 'download',
          source: 'bundle/',
          destination: destDir,
        }),
      ).rejects.toThrow(/cannot be safely mapped/)
      return
    }

    await downloadCommand(fx.bucket, {
      ...baseInputs(),
      action: 'download',
      source: 'bundle/',
      destination: destDir,
    })

    await expect(readFile(join(destDir, 'release/bin/deploy_.sh'), 'utf8')).resolves.toBe(
      'underscore',
    )
    await expect(readFile(join(destDir, 'release/bin/deploy|.sh'), 'utf8')).resolves.toBe('pipe')
    await expect(readFile(join(destDir, 'tools/tool*.sh'), 'utf8')).resolves.toBe('star')
    await expect(readFile(join(destDir, 'tools/tool?.sh'), 'utf8')).resolves.toBe('question')
    await expect(readFile(join(destDir, 'slash/a/b.txt'), 'utf8')).resolves.toBe('slash')
    await expect(readFile(join(destDir, 'slash/a\\b.txt'), 'utf8')).resolves.toBe('backslash')
    await expect(readFile(join(destDir, 'trailing/archive.'), 'utf8')).resolves.toBe('dot')
    await expect(readFile(join(destDir, 'trailing/archive '), 'utf8')).resolves.toBe('space')
    await expect(readFile(join(destDir, 'dot-prefix/..foo'), 'utf8')).resolves.toBe('dot-prefix')
    await expect(readFile(join(destDir, 'windows/CON'), 'utf8')).resolves.toBe('reserved')
  })

  it('uses actual filesystem case behavior for prefix collision checks', async () => {
    for (const [fileName, body] of [
      ['bundle/case/Case.txt', 'upper'],
      ['bundle/case/case.txt', 'lower'],
    ] as const) {
      const local = join(fx.workDir, `${body}.txt`)
      await writeFile(local, body)
      await uploadCommand(fx.bucket, {
        ...baseInputs(),
        source: local,
        destination: fileName,
      })
    }

    const destDir = join(fx.workDir, 'case-out')
    await mkdir(destDir)

    if (await isCaseInsensitiveDirectory(destDir)) {
      await expect(
        downloadCommand(fx.bucket, {
          ...baseInputs(),
          action: 'download',
          source: 'bundle/case/',
          destination: destDir,
        }),
      ).rejects.toThrow(/download path collision/)
      return
    }

    await downloadCommand(fx.bucket, {
      ...baseInputs(),
      action: 'download',
      source: 'bundle/case/',
      destination: destDir,
    })

    await expect(readFile(join(destDir, 'Case.txt'), 'utf8')).resolves.toBe('upper')
    await expect(readFile(join(destDir, 'case.txt'), 'utf8')).resolves.toBe('lower')
  })

  it('rejects unsafe prefix path segments before they can overwrite files', async () => {
    for (const [prefix, unsafeName] of [
      ['dup/', 'dup/a//b.txt'],
      ['dot/', 'dot/a/../b.txt'],
      ['del/', 'del/has-del\u007f.txt'],
    ] as const) {
      const validName = `${prefix}safe.txt`
      const downloadCalls: string[] = []
      const originalListFileNames = fx.bucket.listFileNames.bind(fx.bucket)
      const originalDownload = fx.bucket.download.bind(fx.bucket)
      fx.bucket.listFileNames = async () =>
        ({
          files: [
            { action: 'upload', fileName: validName },
            { action: 'upload', fileName: unsafeName },
          ],
          nextFileName: null,
        }) as unknown as Awaited<ReturnType<typeof fx.bucket.listFileNames>>
      fx.bucket.download = async (...args: Parameters<typeof fx.bucket.download>) => {
        downloadCalls.push(args[0])
        return await originalDownload(...args)
      }

      const destDir = join(fx.workDir, `${prefix.replace('/', '')}-out`)
      try {
        await expect(
          downloadCommand(fx.bucket, {
            ...baseInputs(),
            action: 'download',
            source: prefix,
            destination: destDir,
          }),
        ).rejects.toThrow(`download path for B2 file "${unsafeName}"`)
        expect(downloadCalls).toEqual([])
      } finally {
        fx.bucket.listFileNames = originalListFileNames
        fx.bucket.download = originalDownload
      }
    }
  })

  it('rejects file-directory prefix collisions before downloading', async () => {
    for (const fileNames of [
      ['bundle/a', 'bundle/a/b.txt'],
      ['bundle/c/d.txt', 'bundle/c'],
    ] as const) {
      const downloadCalls: string[] = []
      const originalListFileNames = fx.bucket.listFileNames.bind(fx.bucket)
      const originalDownload = fx.bucket.download.bind(fx.bucket)
      fx.bucket.listFileNames = async () =>
        ({
          files: fileNames.map((fileName) => ({ action: 'upload', fileName })),
          nextFileName: null,
        }) as unknown as Awaited<ReturnType<typeof fx.bucket.listFileNames>>
      fx.bucket.download = async (...args: Parameters<typeof fx.bucket.download>) => {
        downloadCalls.push(args[0])
        return await originalDownload(...args)
      }

      try {
        await expect(
          downloadCommand(fx.bucket, {
            ...baseInputs(),
            action: 'download',
            source: 'bundle/',
            destination: join(fx.workDir, `file-dir-${downloadCalls.length}`),
          }),
        ).rejects.toThrow(/download path collision/)
        expect(downloadCalls).toEqual([])
      } finally {
        fx.bucket.listFileNames = originalListFileNames
        fx.bucket.download = originalDownload
      }
    }
  })

  it('rejects prefix downloads through symlinked destination components', async () => {
    const local = join(fx.workDir, 'escape.txt')
    await writeFile(local, 'escape')
    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'bundle/link/escape.txt',
    })

    const destDir = join(fx.workDir, 'dest')
    const outsideDir = join(fx.workDir, 'outside')
    await mkdir(destDir)
    await mkdir(outsideDir)
    await symlink(outsideDir, join(destDir, 'link'), 'dir')

    await expect(
      downloadCommand(fx.bucket, {
        ...baseInputs(),
        action: 'download',
        source: 'bundle/',
        destination: destDir,
      }),
    ).rejects.toThrow(/escapes destination directory/)
  })

  it('does not write through an existing leaf symlink', async () => {
    if (process.platform === 'win32') return

    const local = join(fx.workDir, 'report.txt')
    await writeFile(local, 'downloaded report')
    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'bundle/report.txt',
    })

    const destDir = join(fx.workDir, 'dest-leaf')
    const outsideDir = join(fx.workDir, 'outside-leaf')
    const outsideFile = join(outsideDir, 'target.txt')
    await mkdir(destDir)
    await mkdir(outsideDir)
    await writeFile(outsideFile, 'outside original')
    await symlink(outsideFile, join(destDir, 'report.txt'), 'file')

    await downloadCommand(fx.bucket, {
      ...baseInputs(),
      action: 'download',
      source: 'bundle/',
      destination: destDir,
    })

    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside original')
    await expect(readFile(join(destDir, 'report.txt'), 'utf8')).resolves.toBe('downloaded report')
  })

  it('rechecks prefix download ancestry after planning before writing', async () => {
    if (process.platform === 'win32') return

    const local = join(fx.workDir, 'toctou.txt')
    await writeFile(local, 'toctou body')
    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'bundle/link/file.txt',
    })

    const destDir = join(fx.workDir, 'dest-toctou')
    const outsideDir = join(fx.workDir, 'outside-toctou')
    const linkPath = join(destDir, 'link')
    await mkdir(destDir)
    await mkdir(outsideDir)

    const originalDownload = fx.bucket.download.bind(fx.bucket)
    fx.bucket.download = async (...args: Parameters<typeof fx.bucket.download>) => {
      await rm(linkPath, { recursive: true, force: true })
      await symlink(outsideDir, linkPath, 'dir')
      return await originalDownload(...args)
    }

    try {
      await expect(
        downloadCommand(fx.bucket, {
          ...baseInputs(),
          action: 'download',
          source: 'bundle/',
          destination: destDir,
        }),
      ).rejects.toThrow(/escapes destination directory/)
      await expect(readFile(join(outsideDir, 'file.txt'), 'utf8')).rejects.toThrow()
    } finally {
      fx.bucket.download = originalDownload
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

async function isCaseInsensitiveDirectory(dir: string): Promise<boolean> {
  const marker = `case-check-${randomBytes(8).toString('hex')}`
  const lowerPath = join(dir, marker.toLowerCase())
  const upperPath = join(dir, marker.toUpperCase())

  await writeFile(lowerPath, '')
  try {
    await readFile(upperPath)
    return true
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return false
    }
    throw error
  } finally {
    await rm(lowerPath, { force: true })
  }
}

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
