import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Bucket, FileVersion, ProgressEvent } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadCommand, replaceDownloadedFile } from '../../src/commands/download.ts'
import { uploadCommand } from '../../src/commands/upload.ts'
import type { ParsedInputs } from '../../src/inputs.ts'
import { parseSse } from '../../src/sse.ts'
import {
  captureStdout,
  makeFixture,
  makeInputs,
  makeMultipartFixture,
  seedFile,
  type TestFixture,
} from '../_helpers.ts'

function baseInputs(): ParsedInputs {
  return makeInputs('upload')
}

const MULTIPART_ABORT_REASON = 'test abort after multipart progress'
type UploadCall = Parameters<Bucket['upload']>[0]

interface CapturingUploadBucket {
  bucket: Bucket
  uploadCalls: UploadCall[]
}

function makeCapturingUploadBucket(resultFileInfo?: Record<string, string>): CapturingUploadBucket {
  const uploadCalls: UploadCall[] = []
  const commandBucket: Pick<Bucket, 'name' | 'upload'> = {
    name: 'fake-bucket',
    upload: async (options: UploadCall): Promise<FileVersion> => {
      uploadCalls.push(options)
      await options.source.toArrayBuffer()
      return makeUploadFileVersion(options, resultFileInfo ?? options.fileInfo ?? {})
    },
  }

  // uploadCommand only relies on the public command boundary captured above.
  return { bucket: commandBucket as unknown as Bucket, uploadCalls }
}

function makeUploadFileVersion(options: UploadCall, fileInfo: Record<string, string>): FileVersion {
  return {
    accountId: 'account-id' as FileVersion['accountId'],
    action: 'upload',
    bucketId: 'bucket-id' as FileVersion['bucketId'],
    contentLength: options.source.size,
    contentMd5: null,
    contentSha1: 'fake-sha1',
    contentType: options.contentType ?? 'b2/x-auto',
    fileId: 'fake-file-id' as FileVersion['fileId'],
    fileInfo,
    fileName: options.fileName,
    fileRetention: { isClientAuthorizedToRead: true, value: null },
    legalHold: { isClientAuthorizedToRead: true, value: null },
    serverSideEncryption: { mode: 'none' },
    uploadTimestamp: Date.now(),
  }
}

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

  it('passes fileInfo, content headers, and preserved mtime to upload', async () => {
    const local = join(fx.workDir, 'metadata.txt')
    await writeFile(local, 'payload')
    const mtime = new Date('2026-02-03T04:05:06.789Z')
    await utimes(local, mtime, mtime)
    const expectedMtime = Math.trunc((await stat(local)).mtimeMs)
    const { bucket, uploadCalls } = makeCapturingUploadBucket()

    const result = await uploadCommand(bucket, {
      ...baseInputs(),
      source: local,
      destination: 'metadata.txt',
      contentType: 'text/plain',
      fileInfo: {
        build_sha: 'abc123',
        'b2-cache-control': 'public, max-age=31536000',
        'b2-content-disposition': 'attachment; filename="metadata.txt"',
      },
      preserveMtime: true,
    })

    const call = uploadCalls[0]
    expect(call).toBeDefined()
    if (call === undefined) throw new Error('upload call was not captured')
    expect(call.contentType).toBe('text/plain')
    expect(call.lastModifiedMillis).toBe(expectedMtime)
    expect(call.fileInfo).toEqual({
      build_sha: 'abc123',
      'b2-cache-control': 'public, max-age=31536000',
      'b2-content-disposition': 'attachment; filename="metadata.txt"',
      src_last_modified_millis: String(expectedMtime),
    })
    expect(result.files[0]?.fileInfo).toEqual({
      build_sha: 'abc123',
      'b2-cache-control': 'public, max-age=31536000',
      'b2-content-disposition': 'attachment; filename="metadata.txt"',
      src_last_modified_millis: String(expectedMtime),
    })
  })

  it('reports SDK-returned fileInfo without merging requested key casing', async () => {
    const local = join(fx.workDir, 'case.txt')
    await writeFile(local, 'case')
    const { bucket } = makeCapturingUploadBucket({ build_sha: 'abc123' })

    const result = await uploadCommand(bucket, {
      ...baseInputs(),
      source: local,
      fileInfo: { Build_SHA: 'abc123' },
    })

    expect(result.files[0]?.fileInfo).toEqual({ build_sha: 'abc123' })
  })

  it('validates near-limit preserved mtime fileInfo before any upload call', async () => {
    const local = join(fx.workDir, 'too-much-metadata.txt')
    await writeFile(local, 'payload')
    const { bucket, uploadCalls } = makeCapturingUploadBucket()
    const encryptedFileInfoBudget = 2048
    const key = 'build'

    await expect(
      uploadCommand(bucket, {
        ...baseInputs(),
        source: local,
        fileInfo: {
          [key]: 'x'.repeat(encryptedFileInfoBudget - key.length),
        },
        encryption: parseSse('B2'),
        preserveMtime: true,
      }),
    ).rejects.toThrow(/Invalid fileInfo entry for "src_last_modified_millis"/)

    expect(uploadCalls).toHaveLength(0)
  })

  it('rejects mixed-case preserved mtime duplicates before any upload call', async () => {
    const local = join(fx.workDir, 'duplicate-metadata.txt')
    await writeFile(local, 'payload')
    const { bucket, uploadCalls } = makeCapturingUploadBucket()

    await expect(
      uploadCommand(bucket, {
        ...baseInputs(),
        source: local,
        fileInfo: {
          SRC_LAST_MODIFIED_MILLIS: '1',
        },
        preserveMtime: true,
      }),
    ).rejects.toThrow(/Duplicate fileInfo key "src_last_modified_millis"/)

    expect(uploadCalls).toHaveLength(0)
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

  it('does not reinterpret planned prefix file paths as directories', async () => {
    const local = join(fx.workDir, 'conflict.txt')
    await writeFile(local, 'downloaded conflict')
    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'bundle/conflict.txt',
    })

    const destDir = join(fx.workDir, 'planned-dir-out')
    const existingDirectoryAtFilePath = join(destDir, 'conflict.txt')
    await mkdir(existingDirectoryAtFilePath, { recursive: true })

    await expect(
      downloadCommand(fx.bucket, {
        ...baseInputs(),
        action: 'download',
        source: 'bundle/',
        destination: destDir,
      }),
    ).rejects.toThrow(/directory|EISDIR|ENOTEMPTY|EEXIST|EPERM/u)
    await expect(
      readFile(join(existingDirectoryAtFilePath, 'conflict.txt'), 'utf8'),
    ).rejects.toThrow()
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

  it('rechecks prefix download root ancestry after planning before writing', async () => {
    if (process.platform === 'win32') return

    const local = join(fx.workDir, 'root-toctou.txt')
    await writeFile(local, 'root toctou body')
    await uploadCommand(fx.bucket, {
      ...baseInputs(),
      source: local,
      destination: 'bundle/file.txt',
    })

    const destDir = join(fx.workDir, 'dest-root-toctou')
    const outsideDir = join(fx.workDir, 'outside-root-toctou')
    await mkdir(destDir)
    await mkdir(outsideDir)

    const originalDownload = fx.bucket.download.bind(fx.bucket)
    fx.bucket.download = async (...args: Parameters<typeof fx.bucket.download>) => {
      await rm(destDir, { recursive: true, force: true })
      await symlink(outsideDir, destDir, 'dir')
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

describe('upload + download: log + branch coverage', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-cov')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('logs the upload progress label and the fileId/sha1 summary line', async () => {
    const local = join(fx.workDir, 'logged.txt')
    await writeFile(local, 'log-me')
    let result: Awaited<ReturnType<typeof uploadCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await uploadCommand(
        fx.bucket,
        makeInputs('upload', fx, { source: local, destination: 'logged.txt' }),
      )
    })
    const first = result?.files[0]
    expect(first?.contentSha1).toBeTruthy()
    expect(out).toContain('upload[logged.txt]')
    expect(out).toContain(`fileId=${first?.fileId} sha1=${first?.contentSha1}`)
  })

  it('downloads a prefix, logging the group, progress, and wrote lines per file', async () => {
    await seedFile(fx, 'pre/a.txt', 'aaa')
    await seedFile(fx, 'pre/b.txt', 'bbbb')
    const destDir = join(fx.workDir, 'out')
    let result: Awaited<ReturnType<typeof downloadCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await downloadCommand(
        fx.bucket,
        makeInputs('download', fx, { source: 'pre/', destination: destDir }),
      )
    })
    expect(result?.files).toHaveLength(2)
    expect(result?.bytesTransferred).toBe(7) // 3 + 4
    expect(out).toContain('::group::download b2://gh-action-cov/pre/a.txt')
    expect(out).toContain('download[pre/a.txt]')
    expect(out).toMatch(/ {2}wrote 3 bytes to .*a\.txt \(sha1=/)
    expect(await readFile(join(destDir, 'a.txt'), 'utf8')).toBe('aaa')
    expect(await readFile(join(destDir, 'b.txt'), 'utf8')).toBe('bbbb')
  })

  it('writes a single file into an existing directory destination by basename', async () => {
    await seedFile(fx, 'one.txt', 'one')
    const destDir = join(fx.workDir, 'existing')
    await mkdir(destDir, { recursive: true })
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'one.txt', destination: destDir }),
    )
    expect(result.files[0]?.localPath).toBe(join(destDir, 'one.txt'))
    expect(await readFile(join(destDir, 'one.txt'), 'utf8')).toBe('one')
  })

  it('writes a single file into a trailing-slash directory destination', async () => {
    await seedFile(fx, 'two.txt', 'two')
    const destDir = join(fx.workDir, 'slash')
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'two.txt', destination: `${destDir}/` }),
    )
    expect(result.files[0]?.localPath).toBe(join(destDir, 'two.txt'))
    expect(await readFile(join(destDir, 'two.txt'), 'utf8')).toBe('two')
  })

  it('round-trips an SSE-C file: download decrypts with the same customer key', async () => {
    const enc = parseSse(`C:${Buffer.alloc(32, 0x61).toString('base64')}`)
    const local = join(fx.workDir, 'enc.txt')
    await writeFile(local, 'secret-body')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: local, destination: 'enc.txt', encryption: enc }),
    )
    const destDir = join(fx.workDir, 'dec')
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, {
        source: 'enc.txt',
        destination: join(destDir, 'enc.txt'),
        encryption: enc,
      }),
    )
    expect(result.files[0]?.size).toBe(11)
    expect(await readFile(join(destDir, 'enc.txt'), 'utf8')).toBe('secret-body')
  })

  it('rejects a Windows-reserved key segment in a prefix download on win32', async () => {
    await seedFile(fx, 'win/con.txt', 'x')
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(
        downloadCommand(
          fx.bucket,
          makeInputs('download', fx, { source: 'win/', destination: join(fx.workDir, 'reserved') }),
        ),
      ).rejects.toThrow(/reserved or contains a Windows path character/)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('rejects a Windows path-character key segment in a prefix download on win32', async () => {
    await seedFile(fx, 'wc/a:b.txt', 'y')
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(
        downloadCommand(
          fx.bucket,
          makeInputs('download', fx, { source: 'wc/', destination: join(fx.workDir, 'illegal') }),
        ),
      ).rejects.toThrow(/reserved or contains a Windows path character/)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('rejects a single-file download whose basename is Windows-reserved on win32', async () => {
    await seedFile(fx, 'aux.txt', 'z')
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      await expect(
        downloadCommand(fx.bucket, makeInputs('download', fx, { source: 'aux.txt' })),
      ).rejects.toThrow(/cannot be safely mapped/)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('rejects a prefix download where one key is a file and another nests beneath it', async () => {
    await seedFile(fx, 'fd/x', 'file-at-x')
    await seedFile(fx, 'fd/x/child.txt', 'nested')
    await expect(
      downloadCommand(
        fx.bucket,
        makeInputs('download', fx, { source: 'fd/', destination: join(fx.workDir, 'nested') }),
      ),
    ).rejects.toThrow(/download path collision/)
  })
})

// Windows refuses to rename over an existing leaf. Exercise the extracted
// replace helper with a rename implementation that behaves that way, without
// pinning the command-level download test to exact fs/promises calls.
describe('download: win32 replace helper', () => {
  it('replaces an existing leaf when win32 rename throws EEXIST', async () => {
    const fx = await makeFixture('gh-action-win-rename')
    try {
      const tempPath = join(fx.workDir, 'fresh-content.tmp')
      const dest = join(fx.workDir, 'leaf-target.txt')
      await writeFile(tempPath, 'fresh-content')
      await writeFile(dest, 'stale-content')

      await replaceDownloadedFile(tempPath, dest, {
        platform: 'win32',
        renameFile: async (from, to) => {
          try {
            await readFile(to)
          } catch (error) {
            if (isFileNotFound(error)) return await rename(from, to)
            throw error
          }
          const err = new Error('EEXIST: file already exists') as NodeJS.ErrnoException
          err.code = 'EEXIST'
          throw err
        },
      })

      expect(await readFile(dest, 'utf8')).toBe('fresh-content')
      await expect(readFile(tempPath)).rejects.toThrow(/ENOENT/u)
    } finally {
      await rm(fx.workDir, { recursive: true, force: true })
    }
  })
})

function isFileNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
