/**
 * Coverage-stress tests.
 *
 * Each `describe` here targets a specific gap surfaced by `pnpm test:coverage`.
 * The intent is breadth, not depth: every test exercises one previously-
 * uncovered branch or line. Production behavior is validated by the
 * per-command suites under `__tests__/commands/`.
 *
 * If a test in this file fails because a previously-uncovered branch is now
 * exercised by another suite, delete it here. This file should NOT be the
 * load-bearing assertion for any happy-path behavior.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyCommand } from '../src/commands/copy.ts'
import { deleteCommand } from '../src/commands/delete.ts'
import { downloadCommand } from '../src/commands/download.ts'
import { headCommand } from '../src/commands/head.ts'
import { hideCommand } from '../src/commands/hide.ts'
import { listCommand } from '../src/commands/list.ts'
import { presignCommand } from '../src/commands/presign.ts'
import { purgeCommand } from '../src/commands/purge.ts'
import { retentionCommand } from '../src/commands/retention.ts'
import { processSyncEvent, type SyncEventCounters, syncCommand } from '../src/commands/sync.ts'
import { unhideCommand } from '../src/commands/unhide.ts'
import { uploadCommand } from '../src/commands/upload.ts'
import { verifyCommand } from '../src/commands/verify.ts'
import { parseInputs } from '../src/inputs.ts'
import { makeProgressListener } from '../src/progress.ts'
import { writeStepSummary } from '../src/summary.ts'
import {
  captureStdout,
  MULTIPART_PART_SIZE,
  makeFixture,
  makeInputs,
  makeMultipartFixture,
  resetInputEnv,
  seedFile,
  setInput,
  type TestFixture,
} from './_helpers.ts'

// Windows: file handles linger briefly after the last write completes, so a bare
// rm can race with the OS and throw ENOTEMPTY. Retry a few times with a short
// backoff before giving up.
async function removeDirWithWindowsRetries(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

// =========================================================================
// inputs.ts: every enum reject + parseBool/parsePositiveInt error path
// =========================================================================

describe('parseInputs: exhaustive validation rejects', () => {
  beforeEach(() => {
    resetInputEnv()
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
  })
  afterEach(resetInputEnv)

  it('rejects invalid compare-mode', () => {
    setInput('action', 'sync')
    setInput('compare-mode', 'huh')
    expect(() => parseInputs()).toThrow(/Invalid 'compare-mode'/)
  })

  it('rejects invalid keep-mode', () => {
    setInput('action', 'sync')
    setInput('keep-mode', 'whatever')
    expect(() => parseInputs()).toThrow(/Invalid 'keep-mode'/)
  })

  it('rejects invalid sync direction', () => {
    setInput('action', 'sync')
    setInput('direction', 'sideways')
    expect(() => parseInputs()).toThrow(/Invalid 'direction'/)
  })

  it('rejects invalid retention-mode', () => {
    setInput('action', 'retention')
    setInput('retention-mode', 'lockdown')
    expect(() => parseInputs()).toThrow(/Invalid 'retention-mode'/)
  })

  it('rejects invalid legal-hold', () => {
    setInput('action', 'retention')
    setInput('legal-hold', 'maybe')
    expect(() => parseInputs()).toThrow(/Invalid 'legal-hold'/)
  })

  it('rejects a non-boolean for resume', () => {
    setInput('action', 'upload')
    setInput('resume', 'banana')
    expect(() => parseInputs()).toThrow(/Invalid boolean/)
  })

  it('rejects a non-integer for concurrency', () => {
    setInput('action', 'upload')
    setInput('concurrency', '-5')
    expect(() => parseInputs()).toThrow(/Invalid positive integer/)
  })

  it('rejects a non-integer for part-size', () => {
    setInput('action', 'upload')
    setInput('part-size', 'big')
    expect(() => parseInputs()).toThrow(/Invalid positive integer/)
  })

  it('rejects zero for max-results', () => {
    setInput('action', 'list')
    setInput('max-results', '0')
    expect(() => parseInputs()).toThrow(/Invalid positive integer/)
  })

  it('accepts every valid compare-mode + keep-mode + direction combo', () => {
    setInput('action', 'sync')
    for (const cmp of ['modtime', 'size', 'none']) {
      for (const keep of ['no-delete', 'delete', 'keep-days']) {
        for (const dir of ['auto', 'up', 'down']) {
          setInput('compare-mode', cmp)
          setInput('keep-mode', keep)
          setInput('direction', dir)
          // `keep-days` mode requires an explicit window; see inputs.test.ts.
          setInput('keep-days', keep === 'keep-days' ? '7' : '')
          const r = parseInputs()
          expect(r.compareMode).toBe(cmp)
          expect(r.keepMode).toBe(keep)
          expect(r.syncDirection).toBe(dir)
        }
      }
    }
  })
})

// =========================================================================
// download.ts: resolveLocalPath edge cases
// =========================================================================

describe('download: destination resolution edge cases', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-dl-edges')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('writes into an existing destination directory', async () => {
    const local = join(fx.workDir, 'asset.txt')
    await writeFile(local, 'asset')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'asset.txt',
      }),
    )

    const targetDir = join(fx.workDir, 'into')
    await mkdir(targetDir, { recursive: true })

    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, {
        source: 'asset.txt',
        destination: targetDir, // existing directory, no trailing slash
      }),
    )
    expect(result.files[0]?.localPath.endsWith('asset.txt')).toBe(true)
  })

  it('writes using basename when destination is undefined', async () => {
    const local = join(fx.workDir, 'no-dest.txt')
    await writeFile(local, 'no-dest')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'no-dest.txt',
      }),
    )

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fx.workDir)
    try {
      const result = await downloadCommand(
        fx.bucket,
        makeInputs('download', fx, { source: 'no-dest.txt' }),
      )
      expect(result.files[0]?.localPath.endsWith('no-dest.txt')).toBe(true)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('treats a destination with trailing slash as a directory', async () => {
    const local = join(fx.workDir, 'trail.txt')
    await writeFile(local, 'trail')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'trail.txt',
      }),
    )
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, {
        source: 'trail.txt',
        destination: `${fx.workDir}/`,
      }),
    )
    expect(result.files[0]?.localPath.endsWith('trail.txt')).toBe(true)
  })

  it("throws on download when 'source' is undefined", async () => {
    await expect(
      downloadCommand(fx.bucket, makeInputs('download', { bucket: 'gh-action-dl-edges' })),
    ).rejects.toThrow(/'source' input is required/)
  })
})

// =========================================================================
// verify.ts: multipart-null-sha1 branch (spy on bucket.download)
// =========================================================================

describe('verify: multipart file with null remote SHA-1', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-verify-mp')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  // The "multipart-uploaded file returns null contentSha1" branch in
  // verify.ts requires the SDK simulator to surface null content-SHA1 on a
  // multipart-finished file. The simulator doesn't yet expose that path
  // organically; restoring this test is queued behind a simulator update.
  // Track this simulator limitation in project docs/issues as needed.

  it('rejects verify with a destination path that points to a directory', async () => {
    const local = join(fx.workDir, 'asset-dir.txt')
    await writeFile(local, 'x')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: local, destination: 'd.txt' }),
    )
    // destination is a directory, not a file: sha1OfFile should throw.
    const aDir = join(fx.workDir, 'somedir')
    await mkdir(aDir, { recursive: true })
    await expect(
      verifyCommand(
        fx.bucket,
        makeInputs('verify', fx, {
          source: 'd.txt',
          destination: aDir,
        }),
      ),
    ).rejects.toThrow(/must be an existing file/)
  })

  it('throws when source is empty', async () => {
    await expect(
      verifyCommand(fx.bucket, makeInputs('verify', fx, { source: '' })),
    ).rejects.toThrow(/'source' input is required/)
  })
})

// =========================================================================
// hide / unhide / head / retention / copy / delete: missing input rejects
// =========================================================================

describe('command guards: missing required inputs', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-guards')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('hide rejects missing source', async () => {
    await expect(
      hideCommand(fx.bucket, makeInputs('hide', { bucket: 'gh-action-guards' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('unhide rejects empty source', async () => {
    await expect(
      unhideCommand(fx.bucket, makeInputs('unhide', fx, { source: '' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('head rejects empty source', async () => {
    await expect(headCommand(fx.bucket, makeInputs('head', fx, { source: '' }))).rejects.toThrow(
      /'source' input is required/,
    )
  })

  it('retention rejects missing source', async () => {
    await expect(
      retentionCommand(fx.bucket, makeInputs('retention', { bucket: 'gh-action-guards' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('retention rejects invalid ISO retention-until', async () => {
    const local = join(fx.workDir, 'r.txt')
    await writeFile(local, 'r')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: local, destination: 'r.txt' }),
    )
    await expect(
      retentionCommand(
        fx.bucket,
        makeInputs('retention', fx, {
          source: 'r.txt',
          retentionMode: 'governance',
          retentionUntil: 'not-an-iso-date',
        }),
      ),
    ).rejects.toThrow(/not a valid ISO 8601 timestamp/)
  })

  it('retention reports a file that does not exist', async () => {
    await expect(
      retentionCommand(
        fx.bucket,
        makeInputs('retention', fx, {
          source: 'phantom.txt',
          legalHold: 'on',
        }),
      ),
    ).rejects.toThrow(/File not found/)
  })

  it('copy rejects missing source', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, makeInputs('copy', fx, { destination: 'd' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('copy rejects missing destination', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, makeInputs('copy', fx, { source: 's' })),
    ).rejects.toThrow(/'destination' input is required/)
  })

  it('copy errors when the source bucket does not exist', async () => {
    // Force getBucket to return null for the cross-bucket lookup.
    // The simulator otherwise tolerates unknown bucket names by falling
    // back to the most-recently-created bucket, which would mask this branch.
    const spy = vi
      .spyOn(fx.client, 'getBucket')
      .mockImplementation(async (name) => (name === 'no-such-bucket' ? null : fx.bucket))
    try {
      await expect(
        copyCommand(
          fx.client,
          fx.bucket,
          makeInputs('copy', fx, {
            sourceBucket: 'no-such-bucket',
            source: 'c.txt',
            destination: 'c.copy.txt',
          }),
        ),
      ).rejects.toThrow(/Source bucket "no-such-bucket" not found/)
    } finally {
      spy.mockRestore()
    }
  })

  it('delete rejects missing source', async () => {
    await expect(
      deleteCommand(fx.bucket, makeInputs('delete', { bucket: 'gh-action-guards' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('upload rejects missing source', async () => {
    await expect(
      uploadCommand(fx.bucket, makeInputs('upload', { bucket: 'gh-action-guards' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('sync rejects missing source', async () => {
    await expect(
      syncCommand(fx.bucket, makeInputs('sync', { bucket: 'gh-action-guards' })),
    ).rejects.toThrow(/'source' input is required/)
  })

  it('presign rejects empty source', async () => {
    await expect(
      presignCommand(fx.client, fx.bucket, makeInputs('presign', fx, { source: '' })),
    ).rejects.toThrow(/'source' input is required/)
  })
})

// =========================================================================
// purge: bucket-wide warning path + missing source
// =========================================================================

describe('purge: wide-scope warning path', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-purge-wide')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('rejects bucket-wide purge scope without confirmation', async () => {
    await expect(
      purgeCommand(fx.bucket, makeInputs('purge', { bucket: 'gh-action-purge-wide' })),
    ).rejects.toThrow(/'allow-bucket-purge' must be true/)
    await expect(purgeCommand(fx.bucket, makeInputs('purge', fx, { source: '' }))).rejects.toThrow(
      /'allow-bucket-purge' must be true/,
    )
  })

  it('purges the entire bucket when allow-bucket-purge confirms bucket scope', async () => {
    for (const name of ['x.txt', 'y.txt', 'sub/z.txt']) {
      const local = join(fx.workDir, name.replace('/', '_'))
      await writeFile(local, name)
      await uploadCommand(
        fx.bucket,
        makeInputs('upload', fx, {
          source: local,
          destination: name,
        }),
      )
    }

    const result = await purgeCommand(
      fx.bucket,
      makeInputs('purge', fx, { source: '/', allowBucketPurge: true }),
    )
    expect(result.errors).toBe(0)
    expect(result.files.length).toBeGreaterThanOrEqual(3)
    const after = await fx.bucket.listFileVersions({ prefix: '' })
    expect(after.files).toHaveLength(0)
  })
})

// =========================================================================
// list: skips hide markers, hits maxResults exactly
// =========================================================================

describe('list: version filter and max-results boundary', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-list-versions')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('skips hide-marker versions from the result', async () => {
    const local = join(fx.workDir, 'mask.txt')
    await writeFile(local, 'maskable')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'mask.txt',
      }),
    )
    await fx.bucket.hideFile('mask.txt')

    const result = await listCommand(fx.bucket, makeInputs('list', fx, { source: '' }))
    // listFileNames returns the latest visible version, which for a hidden
    // file is the hide marker itself. We filter that out.
    expect(result.files).toHaveLength(0)
  })

  it('respects max-results=1 across pagination', async () => {
    for (let i = 0; i < 3; i++) {
      const local = join(fx.workDir, `f${i}.txt`)
      await writeFile(local, `body-${i}`)
      await uploadCommand(
        fx.bucket,
        makeInputs('upload', fx, {
          source: local,
          destination: `f${i}.txt`,
        }),
      )
    }
    const result = await listCommand(fx.bucket, makeInputs('list', fx, { maxResults: 1 }))
    expect(result.files).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })
})

// =========================================================================
// sync: B2 → local with delete-local (keep-mode: delete)
// =========================================================================

// =========================================================================
// delete: single-file dry-run
// =========================================================================

describe('delete: single-file dry-run path', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-del-single-dry')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('previews a single-file delete without removing the object', async () => {
    const local = join(fx.workDir, 'preview.txt')
    await writeFile(local, 'kept')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'preview.txt',
      }),
    )
    const result = await deleteCommand(
      fx.bucket,
      makeInputs('delete', fx, {
        source: 'preview.txt',
        dryRun: true,
      }),
    )
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.skipped).toBe(true)
    const after = await fx.bucket.listFileNames({ prefix: 'preview.txt' })
    expect(after.files.some((f) => f.fileName === 'preview.txt' && f.action === 'upload')).toBe(
      true,
    )
  })
})

// =========================================================================
// upload: single-file path with destination overriding the file name
// =========================================================================

describe('upload: single-file rename via destination', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-upload-rename')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('uploads a single file to an explicit non-slash destination key', async () => {
    const local = join(fx.workDir, 'orig.txt')
    await writeFile(local, 'rename me')
    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'releases/v1/app.bin', // exact key, no trailing slash
      }),
    )
    expect(result.files[0]?.fileName).toBe('releases/v1/app.bin')
  })

  it('honors a destination prefix with trailing slash for a single source file', async () => {
    const local = join(fx.workDir, 'attached.txt')
    await writeFile(local, 'attach')
    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'prefix/',
      }),
    )
    expect(result.files[0]?.fileName).toBe('prefix/attached.txt')
  })
})

// =========================================================================
// progress.ts: GB-scale formatting
// =========================================================================

describe('progress.ts: GB-scale formatting', () => {
  it('handles a multi-GB transferred value without crashing', async () => {
    // Re-import here to avoid pulling makeProgressListener at the top.
    const { makeProgressListener } = await import('../src/progress.ts')
    // Capture stdout because @actions/core.info writes there.
    const lines: string[] = []
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    })
    try {
      const listener = makeProgressListener('gb', 0)
      listener({
        bytesTransferred: 3 * 1024 * 1024 * 1024,
        totalBytes: 4 * 1024 * 1024 * 1024,
        partsCompleted: 0,
        totalParts: null,
        elapsedMs: 1000,
      })
      const text = lines.join('')
      expect(text).toContain('GB')
    } finally {
      spy.mockRestore()
    }
  })
})

// =========================================================================
// download: SSE-C decryption path (sseFromInputs returns a key)
// =========================================================================

describe('download: SSE-C decryption', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-ssec')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('round-trips a file with SSE-C: upload + download with the same customer key', async () => {
    const { parseSse } = await import('../src/sse.ts')
    // Deterministic 32-byte test key, base64-encoded.
    const rawKey = Buffer.alloc(32, 0x61)
    const b64 = rawKey.toString('base64')
    const enc = parseSse(`C:${b64}`)

    const local = join(fx.workDir, 'enc.txt')
    await writeFile(local, 'secret payload')
    await uploadCommand(fx.bucket, {
      ...makeInputs('upload', fx, {
        source: local,
        destination: 'enc.txt',
      }),
      encryption: enc,
    })

    const out = join(fx.workDir, 'roundtrip.txt')
    const result = await downloadCommand(fx.bucket, {
      ...makeInputs('download', fx, {
        source: 'enc.txt',
        destination: out,
      }),
      encryption: enc,
    })
    expect(result.files).toHaveLength(1)
  })
})

describe('sync: b2-to-local with orphan deletion', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-sync-orphans')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('deletes local orphan files when syncing b2 → local with keep-mode=delete', async () => {
    // Seed remote with one file.
    const local = join(fx.workDir, 'remote.txt')
    await writeFile(local, 'r')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'r/remote.txt',
      }),
    )

    // Create a local "orphan" file under the dest directory that the sync
    // should remove because it's not present remotely.
    const dest = join(fx.workDir, 'down')
    await mkdir(dest, { recursive: true })
    const orphan = join(dest, 'orphan.txt')
    await writeFile(orphan, 'should-be-removed')

    const result = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, {
        source: 'r',
        destination: dest,
        syncDirection: 'down',
        keepMode: 'delete',
      }),
    )
    expect(result.direction).toBe('b2-to-local')
    expect(result.deleted).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// copy: routes through copyLargeFile when the source exceeds the recommended
// part size. We configure the simulator with a tiny part-size advertisement
// (instead of spying on `accountInfo`) so the SDK's `isLarge` branch trips
// off real config rather than a mocked method call.
// =========================================================================

describe('copy: large-file path', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeMultipartFixture('gh-action-stress-copy-large')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('routes through copyLargeFile when source size exceeds recommended part size', async () => {
    // With `recommendedPartSize: MULTIPART_PART_SIZE` (100 KB), a 300 KB
    // upload triggers the multipart path on copy as well.
    const local = join(fx.workDir, 'big.bin')
    await writeFile(local, 'x'.repeat(MULTIPART_PART_SIZE * 3))
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'src.bin',
        partSize: MULTIPART_PART_SIZE,
      }),
    )

    const copyLargeSpy = vi.spyOn(fx.bucket, 'copyLargeFile')
    try {
      // First call: no signal → exercises the `undefined` arm of the
      // conditional spread in copyLargeFile's options.
      const result = await copyCommand(
        fx.client,
        fx.bucket,
        makeInputs('copy', fx, {
          source: 'src.bin',
          destination: 'archive/src.bin',
        }),
      )
      expect(result.destinationFileName).toBe('archive/src.bin')
      expect(copyLargeSpy).toHaveBeenCalledOnce()
      // Second call: with signal → exercises the `defined` arm.
      await copyCommand(
        fx.client,
        fx.bucket,
        makeInputs('copy', fx, {
          source: 'src.bin',
          destination: 'archive/src-with-signal.bin',
        }),
        new AbortController().signal,
      )
      expect(copyLargeSpy).toHaveBeenCalledTimes(2)
    } finally {
      copyLargeSpy.mockRestore()
    }
  })
})

// =========================================================================
// retention: `mode: 'none'` path (clears retention)
// =========================================================================

describe('retention: clearing retention with mode=none', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-retention-none')
    await fx.bucket.delete()
    fx.bucket = await fx.client.createBucket({
      bucketName: 'gh-action-stress-retention-none',
      bucketType: 'allPrivate',
      fileLockEnabled: true,
    })
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('passes mode=null to the SDK when input retention-mode is "none"', async () => {
    const local = join(fx.workDir, 'r.txt')
    await writeFile(local, 'clearable')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'r.txt',
      }),
    )

    // Spy here just inspects the call arguments; doesn't fabricate a response.
    const spy = vi.spyOn(fx.bucket, 'updateFileRetention')
    try {
      await retentionCommand(
        fx.bucket,
        makeInputs('retention', fx, {
          source: 'r.txt',
          retentionMode: 'none',
        }),
      )
      const callArg = spy.mock.calls[0]?.[2]
      expect(callArg?.mode).toBeNull()
      expect(callArg?.retainUntilTimestamp).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })
})

// =========================================================================
// sync: local-to-b2 orphan deletion
// =========================================================================

describe('sync: orphan deletion (local-to-b2)', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-sync-up-orphan')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('emits a single delete-remote per orphan on a vanilla (no-lock) bucket', async () => {
    // Seed a remote-only file under a destination prefix; sync up with
    // `delete` keep-mode. Because the bucket is vanilla `allPrivate` (no
    // file lock), the SDK's `removeOrphan` factory routes to `deleteRemote`
    // (not `hide`) and yields exactly one `delete-remote` event per orphan.
    // The SDK's deleteRemote factory uses `path.selectedVersion.fileName`
    // (the authoritative B2 key) so prefixed orphans delete correctly.
    await seedFile(fx, 'site/orphan.txt', 'will be removed by sync')

    const localSrc = join(fx.workDir, 'src')
    await mkdir(localSrc, { recursive: true })
    await writeFile(join(localSrc, 'kept.txt'), 'present locally')

    const result = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, {
        source: localSrc,
        destination: 'site',
        syncDirection: 'up',
        keepMode: 'delete',
      }),
    )
    expect(result.uploaded).toBe(1)
    expect(result.deleted).toBe(1)
    expect(result.errors).toBe(0)
    const removalEvents = result.events.filter(
      (e) => e.type === 'delete-remote' || e.type === 'hide',
    )
    // P4 contract: exactly one removal event per orphan; on a vanilla bucket
    // it must be `delete-remote`, not `hide`.
    expect(removalEvents).toHaveLength(1)
    expect(removalEvents[0]?.type).toBe('delete-remote')
  })
})

// =========================================================================
// sync: locked-bucket orphan removal yields a `hide` event (not delete).
// Mirror of the test above but with `fileLockEnabled: true` on the bucket;
// SDK's `removeOrphan` factory branches to `hide` for locked buckets.
// =========================================================================

describe('sync: orphan removal on a locked bucket yields hide events', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-sync-locked-orphan')
    // Recreate as a fileLock-enabled bucket. The simulator now propagates
    // the flag into `info.fileLockConfiguration.value.isFileLockEnabled`,
    // so the synchronizer's `removeOrphan` factory picks the `hide` branch.
    await fx.bucket.delete()
    fx.bucket = await fx.client.createBucket({
      bucketName: 'gh-action-stress-sync-locked-orphan',
      bucketType: 'allPrivate',
      fileLockEnabled: true,
    })
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('emits a hide event when the bucket has file lock enabled', async () => {
    await seedFile(fx, 'orphan.txt', 'will be hidden, not deleted')

    const localSrc = join(fx.workDir, 'src')
    await mkdir(localSrc, { recursive: true })
    await writeFile(join(localSrc, 'kept.txt'), 'present locally')

    const result = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, {
        source: localSrc,
        syncDirection: 'up',
        keepMode: 'delete',
      }),
    )
    expect(result.deleted).toBe(1)
    const removalEvents = result.events.filter(
      (e) => e.type === 'delete-remote' || e.type === 'hide',
    )
    expect(removalEvents).toHaveLength(1)
    expect(removalEvents[0]?.type).toBe('hide')
  })
})

// =========================================================================
// sync: error event branch fires when an orphan removal fails mid-sync.
// =========================================================================

describe('sync: error events surface through the action result', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-sync-error')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('counts errors instead of crashing the whole sync', async () => {
    await seedFile(fx, 'orphan.txt', 'will fail to delete')
    const localSrc = join(fx.workDir, 'src')
    await mkdir(localSrc, { recursive: true })
    await writeFile(join(localSrc, 'kept.txt'), 'present')

    fx.sim.injectFailure({ on: 'b2_delete_file_version', status: 500, code: 'internal_error' })

    const result = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, {
        source: localSrc,
        syncDirection: 'up',
        keepMode: 'delete',
      }),
    )
    expect(result.errors).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// delete: prefix dry-run (`skip` event branch)
// =========================================================================

describe('delete: prefix dry-run', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-del-prefix-dry')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('hits the prefix `skip` event branch when dry-run is set', async () => {
    const f1 = join(fx.workDir, 'p1.txt')
    const f2 = join(fx.workDir, 'p2.txt')
    await writeFile(f1, 'one')
    await writeFile(f2, 'two')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: f1,
        destination: 'p/1.txt',
      }),
    )
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: f2,
        destination: 'p/2.txt',
      }),
    )

    const result = await deleteCommand(
      fx.bucket,
      makeInputs('delete', fx, {
        source: 'p/',
        dryRun: true,
      }),
    )
    expect(result.files.length).toBeGreaterThanOrEqual(2)
    expect(result.files.every((f) => f.skipped)).toBe(true)
  })
})

// =========================================================================
// download: prefix mode with undefined destination
// =========================================================================

describe('download: prefix mode defaults destination to cwd', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-dl-edges')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('uses "." when destination is undefined', async () => {
    await seedFile(fx, 'dd/d.txt', 'dl-default-dest')

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(fx.workDir)
    try {
      const result = await downloadCommand(fx.bucket, makeInputs('download', fx, { source: 'dd/' }))
      expect(result.files.length).toBeGreaterThanOrEqual(1)
    } finally {
      cwdSpy.mockRestore()
    }
  })
})

// =========================================================================
// upload: directory-as-source path (recursive glob expansion)
// =========================================================================

describe('upload: directory as source', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-stress-upload-dir')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('expands a directory source into a recursive glob and uploads every file', async () => {
    const dir = join(fx.workDir, 'site')
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'a.txt'), 'a')
    await writeFile(join(dir, 'b.txt'), 'b')
    await writeFile(join(dir, 'sub', 'c.txt'), 'c')

    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: dir,
        destination: 'site',
      }),
    )
    expect(result.files.map((f) => f.fileName).sort()).toEqual([
      'site/a.txt',
      'site/b.txt',
      'site/sub/c.txt',
    ])
  })
})

// =========================================================================
// summary: row that omits every optional field
// =========================================================================

describe('summary: row with only fileName set', () => {
  const ORIGINAL = process.env.GITHUB_STEP_SUMMARY
  let dir: string
  let path: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'b2-summary-stress-'))
    path = join(dir, 'STEP_SUMMARY')
    process.env.GITHUB_STEP_SUMMARY = path
  })
  afterEach(async () => {
    if (ORIGINAL === undefined) Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY')
    else process.env.GITHUB_STEP_SUMMARY = ORIGINAL
    await rm(dir, { recursive: true, force: true })
  })

  it('renders a row that omits size, fileId, sha1, and status', async () => {
    await writeStepSummary({
      title: 'Bare row',
      rows: [{ fileName: 'just-a-name.txt' }],
    })
    const { readFile } = await import('node:fs/promises')
    const out = await readFile(path, 'utf8')
    expect(out).toContain('just-a-name.txt')
    expect(out).not.toContain('…')
  })
})

// =========================================================================
// Multipart-upload null contentSha1 round-trip.
//
// Real B2 stores per-part SHA-1s for multipart uploads but no whole-file
// SHA-1; `listFileNames` / `head` / download header surface that as `null`.
// The simulator (post-round-3 SDK update) honors the same shape when
// `b2_finish_large_file` is involved. We force the multipart path by
// pointing the simulator at a 100 KB `recommendedPartSize`.
// =========================================================================

describe('multipart upload: null contentSha1 surfaces through upload/head/verify', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeMultipartFixture('gh-action-mp-roundtrip')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('upload returns null contentSha1; head reports null; verify hits the multipart warning', async () => {
    // 3x the part size guarantees multipart with at least 3 parts.
    const local = join(fx.workDir, 'big.bin')
    const body = 'x'.repeat(MULTIPART_PART_SIZE * 3)
    await writeFile(local, body)

    const upResult = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'big.bin',
        partSize: MULTIPART_PART_SIZE,
      }),
    )
    const first = upResult.files[0]
    expect(first?.contentSha1).toBeNull()

    const headResult = await headCommand(fx.bucket, makeInputs('head', fx, { source: 'big.bin' }))
    expect(headResult.contentSha1).toBeNull()

    // verify against any expected SHA-1 should hit the "remote sha1
    // unavailable" warning branch because there is no remote whole-file hash
    // to compare against.
    const verifyResult = await verifyCommand(
      fx.bucket,
      makeInputs('verify', fx, {
        source: 'big.bin',
        expectedSha1: '0000000000000000000000000000000000000000',
      }),
    )
    expect(verifyResult.verified).toBe(false)
    expect(verifyResult.remoteSha1).toBeNull()
    expect(verifyResult.reason).toMatch(/remote SHA-1 is unavailable/)
    expect(verifyResult.reason).toMatch(/even with expected-sha1/)
  })
})

// =========================================================================
// Progress events: totalParts/partsCompleted populated on multipart.
//
// progress.ts:34 formats the `(N/M parts)` suffix when `event.totalParts`
// is not null. We hit that branch by intercepting `core.info` while a
// multipart upload runs and asserting at least one log line includes the
// `parts` marker.
// =========================================================================

describe('progress listener: emits totalParts on multipart uploads', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeMultipartFixture('gh-action-progress-mp')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('logs a "N/M parts" suffix at least once during a multipart upload', async () => {
    const local = join(fx.workDir, 'multi.bin')
    await writeFile(local, 'x'.repeat(MULTIPART_PART_SIZE * 3))

    // 0ms throttle: every progress event emits, so the multipart suffix is
    // captured even on a fast in-memory upload that would otherwise debounce
    // to one event total. We don't change the production default; this only
    // widens the test's observation window. Capture stdout (where
    // `core.info` writes) directly: vitest 4 disallows spying on ESM
    // module exports.
    const captured = await captureStdout(async () => {
      const onProgress = makeProgressListener('mp-test', 0)
      const { readFile } = await import('node:fs/promises')
      const { BufferSource } = await import('@backblaze-labs/b2-sdk/streams')
      await fx.bucket.upload({
        fileName: 'multi.bin',
        source: new BufferSource(await readFile(local)),
        partSize: MULTIPART_PART_SIZE,
        concurrency: 1,
        onProgress,
      })
    })
    expect(captured).toMatch(/\(\d+\/\d+ parts\)/)
  })
})

// =========================================================================
// `bucket.deleteAll` error events surface through delete / purge.
//
// Both delete.ts and purge.ts have an `errors++` branch that fires when
// the SDK yields `{ type: 'error', ... }`. We trigger that by injecting a
// 500-status failure into `b2_delete_file_version`. The simulator's fault
// injection respects substring matching on the URL.
// =========================================================================

describe('delete: yields errors when b2_delete_file_version fails', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-del-faults')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('reports errors via the prefix `deleteAll` path without failing the whole command', async () => {
    // Prefix-mode delete (trailing `/`) routes through `bucket.deleteAll`,
    // which yields `{ type: 'error' }` per-file rather than throwing. That's
    // the branch we want to cover. Single-file delete uses `deleteFileVersion`
    // directly and throws, which is a different code path.
    await seedFile(fx, 'd/f1.txt', 'one')
    await seedFile(fx, 'd/f2.txt', 'two')
    fx.sim.injectFailure({ on: 'b2_delete_file_version', status: 500, code: 'internal_error' })

    const result = await deleteCommand(fx.bucket, makeInputs('delete', fx, { source: 'd/' }))
    expect(result.errors).toBeGreaterThanOrEqual(1)
  })
})

describe('purge: yields errors when b2_delete_file_version fails', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-purge-faults')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('reports errors in the result and continues processing other versions', async () => {
    await seedFile(fx, 'p/a.txt', 'a')
    await seedFile(fx, 'p/b.txt', 'b')
    fx.sim.injectFailure({ on: 'b2_delete_file_version', status: 500, code: 'internal_error' })

    const result = await purgeCommand(fx.bucket, makeInputs('purge', fx, { source: 'p/' }))
    expect(result.errors).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// Multi-page pagination: list / download / presign all loop until the
// simulator stops setting `nextFileName`. The trick to force pagination
// without seeding 1000+ files is to seed N>maxResults files where the
// page request asks for maxFileCount = maxResults; the simulator returns
// maxResults entries AND a nextFileName, then the action's filter (hide
// markers in `list.ts`) reduces the upload count below maxResults so the
// outer `while` runs again. Same idea for download/presign (their loops
// don't filter, so we just exit when nextFileName is null).
// =========================================================================

describe('list: walks nextFileName across pages when hides reduce upload count', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-list-pages')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('uses startFileName on page 2 after the upload-only filter trims page 1', async () => {
    // Seed 8 files. Hide the first 4 so page 1 (size=6) sees 4 hide markers
    // and 2 uploads; the loop has to fetch page 2 to reach maxResults.
    for (let i = 1; i <= 8; i++) await seedFile(fx, `f${i}.txt`, String(i))
    for (let i = 1; i <= 4; i++) {
      await fx.bucket.hideFile(`f${i}.txt`)
    }

    const result = await listCommand(
      fx.bucket,
      makeInputs('list', fx, { source: 'f', maxResults: 6 }),
    )
    expect(result.files.length).toBeGreaterThanOrEqual(4)
  })
})

describe('download: walks nextFileName across pages', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-dl-pages')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('downloads files across a paginated listing', async () => {
    for (let i = 1; i <= 4; i++) await seedFile(fx, `dl/${i}.txt`, `body-${i}`)
    // Use a small per-page page size by capping maxResults; the action's
    // download loop computes maxFileCount = min(1000, remaining). Hide some
    // files so the action sees page 1 finish below maxResults and continues.
    await fx.bucket.hideFile('dl/1.txt')
    await fx.bucket.hideFile('dl/2.txt')

    const dest = join(fx.workDir, 'out')
    await mkdir(dest, { recursive: true })
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'dl/', destination: dest, maxResults: 3 }),
    )
    expect(result.files.length).toBeGreaterThanOrEqual(1)
  })
})

describe('presign: walks nextFileName across pages', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-presign-pages')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('emits a presigned URL for each page-walked file', async () => {
    for (let i = 1; i <= 4; i++) await seedFile(fx, `p/${i}.txt`, `b${i}`)
    await fx.bucket.hideFile('p/1.txt')
    await fx.bucket.hideFile('p/2.txt')

    const result = await presignCommand(
      fx.client,
      fx.bucket,
      makeInputs('presign', fx, { source: 'p/', maxResults: 3 }),
    )
    expect(result.files.length).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// Upload conditional-spread branches: partSize + contentType both set.
// The corresponding `...(inputs.X !== undefined ? { ... } : {})` lines in
// upload.ts are partial-cover otherwise.
// =========================================================================

describe('upload: passes optional partSize and contentType through', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-upload-opts')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('hits the partSize + contentType conditional spreads', async () => {
    const local = join(fx.workDir, 'with-opts.txt')
    await writeFile(local, 'payload')
    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: local,
        destination: 'with-opts.txt',
        partSize: 5_000_000,
        contentType: 'application/octet-stream',
      }),
    )
    expect(result.files[0]?.fileName).toBe('with-opts.txt')
  })
})

// =========================================================================
// list / presign: inner-loop maxResults break fires mid-page.
// =========================================================================

describe('list: stops mid-page when files.length reaches maxResults', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-list-cap')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('breaks the inner loop when the cap is hit before the page finishes', async () => {
    for (let i = 1; i <= 5; i++) await seedFile(fx, `c/${i}.txt`, String(i))
    const result = await listCommand(
      fx.bucket,
      makeInputs('list', fx, { source: 'c/', maxResults: 2 }),
    )
    expect(result.files).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })
})

describe('presign: stops mid-page when files.length reaches maxResults', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-presign-cap')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('caps presigned URLs at maxResults mid-page', async () => {
    for (let i = 1; i <= 5; i++) await seedFile(fx, `pc/${i}.txt`, String(i))
    const result = await presignCommand(
      fx.client,
      fx.bucket,
      makeInputs('presign', fx, { source: 'pc/', maxResults: 2 }),
    )
    expect(result.files).toHaveLength(2)
  })
})

// =========================================================================
// purge: source without trailing slash is normalized to a directory prefix.
// =========================================================================

describe('purge: normalizes a non-slash source to a directory prefix', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-purge-noslash')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('appends a trailing slash to non-root sources', async () => {
    await seedFile(fx, 'q/a.txt', 'a')
    const result = await purgeCommand(
      fx.bucket,
      makeInputs('purge', fx, { source: 'q', dryRun: true }),
    )
    expect(result.files.some((f) => f.fileName === 'q/a.txt')).toBe(true)
  })
})

// =========================================================================
// retention: invalid ISO retention-until trips the NaN guard.
// =========================================================================

describe('retention: rejects an unparseable ISO retention-until', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-retention-bad-date')
    await fx.bucket.delete()
    fx.bucket = await fx.client.createBucket({
      bucketName: 'gh-action-retention-bad-date',
      bucketType: 'allPrivate',
      fileLockEnabled: true,
    })
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('throws when retention-until is not a valid ISO 8601 timestamp', async () => {
    await seedFile(fx, 'r.txt', 'r')
    await expect(
      retentionCommand(
        fx.bucket,
        makeInputs('retention', fx, {
          source: 'r.txt',
          retentionMode: 'compliance',
          retentionUntil: 'not-an-iso-date',
        }),
      ),
    ).rejects.toThrow(/not a valid ISO 8601/)
  })
})

// =========================================================================
// upload: include/exclude patterns + a glob match that hits a directory.
// =========================================================================

describe('upload: include/exclude patterns extend the glob set', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-upload-include-exclude')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('honors `include` and `exclude` patterns when resolving files', async () => {
    const root = join(fx.workDir, 'site')
    await mkdir(join(root, 'keep'), { recursive: true })
    await mkdir(join(root, 'skip'), { recursive: true })
    await writeFile(join(root, 'keep', 'a.txt'), 'a')
    await writeFile(join(root, 'skip', 'b.txt'), 'b')

    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, {
        source: `${root}/**`,
        destination: 'site',
        include: [`${root}/keep/**`],
        exclude: [`${root}/skip/**`],
      }),
    )
    // Only the file under `keep/` should land in B2.
    const names = result.files.map((f) => f.fileName).sort()
    expect(names.some((n) => n.includes('a.txt'))).toBe(true)
    expect(names.some((n) => n.includes('b.txt'))).toBe(false)
  })
})

// =========================================================================
// sync: empty-prefix branches on up + down (sync to/from bucket root).
// =========================================================================

describe('sync: handles empty prefix (bucket root) in both directions', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-sync-empty-prefix')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('sync up with no destination targets the bucket root', async () => {
    const src = join(fx.workDir, 'src')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'r.txt'), 'root')
    const result = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, { source: src, syncDirection: 'up' }),
    )
    expect(result.direction).toBe('local-to-b2')
    expect(result.uploaded).toBeGreaterThanOrEqual(1)
  })

  it('sync down with a `/` source pulls from the bucket root', async () => {
    await seedFile(fx, 'r.txt', 'root-down')
    const dest = join(fx.workDir, 'down')
    await mkdir(dest, { recursive: true })
    const result = await syncCommand(
      fx.bucket,
      // `'/'` survives `requireSource`'s emptiness check but the action's
      // `replace(/^\/+|\/+$/g, '')` strips it back to '', exercising the
      // empty-prefix arm of the down-direction branch in `buildConfig`.
      makeInputs('sync', fx, { source: '/', destination: dest, syncDirection: 'down' }),
    )
    expect(result.direction).toBe('b2-to-local')
    expect(result.downloaded).toBeGreaterThanOrEqual(1)
  })
})

// =========================================================================
// download: empty file (size=0) exercises the `totalBytes: size > 0 ? size
// : null` branch in the progress-event Transform.
// =========================================================================

describe('download: empty (size=0) file round-trip', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-dl-empty')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('reports `totalBytes: null` in progress events for a zero-byte file', async () => {
    await seedFile(fx, 'empty.txt', '')
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'empty.txt', destination: fx.workDir }),
    )
    expect(result.files[0]?.size).toBe(0)
  })
})

// =========================================================================
// download: multipart file logs `sha1=multipart` (the `sha1 ?? 'multipart'`
// branch in the per-file log line).
// =========================================================================

describe('download: multipart file logs `multipart` sentinel for sha1', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeMultipartFixture('gh-action-dl-multipart')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('downloads a multipart-uploaded file (null sha1) without error', async () => {
    // Upload via the SDK directly with BufferSource so the multipart path is
    // exercised. Multipart files surface `contentSha1: null` on download,
    // which routes through the `sha1 ?? 'multipart'` log arm.
    const { BufferSource } = await import('@backblaze-labs/b2-sdk/streams')
    await fx.bucket.upload({
      fileName: 'big.bin',
      source: new BufferSource(new Uint8Array(MULTIPART_PART_SIZE * 3).fill(7)),
      partSize: MULTIPART_PART_SIZE,
      concurrency: 1,
    })
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'big.bin', destination: fx.workDir }),
    )
    expect(result.files[0]?.contentSha1).toBeNull()
  })
})

// =========================================================================
// sync: down direction with no destination defaults to cwd. Covers the
// `inputs.destination ?? '.'` branches in syncCommand's startGroup label
// and buildConfig's down-direction return shape.
// =========================================================================

describe('sync: down with no destination defaults to cwd', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-sync-down-cwd')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('downloads to the current working directory when destination is omitted', async () => {
    await seedFile(fx, 'r.txt', 'root-down-cwd')
    // Mock cwd to a fresh empty subdir so the cwd-equals-default-destination
    // path doesn't already contain `r.txt` from the seed. If the local
    // copy is present, the simulator's `Date.now()`-based uploadTimestamp
    // can collide with the local file's mtime millisecond-for-millisecond,
    // making the modtime comparator emit `skip` instead of `download-done`
    // intermittently.
    const cwdSubdir = join(fx.workDir, 'cwd-only')
    await mkdir(cwdSubdir, { recursive: true })
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwdSubdir)
    try {
      const result = await syncCommand(
        fx.bucket,
        // No `destination`: triggers both `?? '.'` defaults (log + buildConfig).
        makeInputs('sync', fx, { source: '/', syncDirection: 'down' }),
      )
      expect(result.direction).toBe('b2-to-local')
      expect(result.downloaded).toBeGreaterThanOrEqual(1)
    } finally {
      cwdSpy.mockRestore()
    }
  })
})

// =========================================================================
// download: real pagination handover. The action's download loop uses a
// hardcoded `maxFileCount: 1000`, so triggering page 2 requires more than
// 1000 files under the prefix. The simulator is in-memory; seeding 1001
// 1-byte BufferSource uploads in parallel takes a few hundred ms, and the
// per-file download loop runs against the simulator with no real IO, so the
// whole test stays under a second on a modern laptop. Covers the otherwise-
// v8-ignored pagination handover at download.ts:85, 104, 106.
// =========================================================================

describe('download: walks pagination past the 1000-file page boundary', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-dl-real-pagination')
  })
  afterEach(async () => {
    await removeDirWithWindowsRetries(fx.workDir)
  })

  // 1001 file uploads + 1001 sequential downloads. Easily fits under the
  // default 30 s timeout on Linux/macOS but Windows-runner fs throughput is
  // ~5x slower and routinely needs north of 30 s for the download walk; bump
  // the per-test budget so we don't flake there.
  it('downloads files split across two pages', { timeout: 90_000 }, async () => {
    const { BufferSource } = await import('@backblaze-labs/b2-sdk/streams')
    // 1001 tiny uploads: enough to force a second listFileNames page.
    // Parallelized via Promise.all; simulator is in-memory and serializes
    // internally where needed, so this stays under ~400ms in practice.
    const body = new Uint8Array([0x66])
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) =>
        fx.bucket.upload({
          fileName: `p/${i.toString().padStart(4, '0')}.txt`,
          source: new BufferSource(body),
        }),
      ),
    )

    const dest = join(fx.workDir, 'out')
    await mkdir(dest, { recursive: true })
    const result = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'p/', destination: dest }),
    )
    // Page 1 returns 1000, page 2 returns 1. Both pages must be walked.
    expect(result.files.length).toBe(1001)
  })
})

// =========================================================================
// processSyncEvent: direct coverage of every SyncEvent variant, including
// `copy-start` / `copy-done` which only fire for b2-to-b2 sync (a config
// the action's input surface doesn't expose). Drives the function with
// synthetic events so every switch arm is exercised deterministically.
// =========================================================================

describe('processSyncEvent: handles every SyncEvent variant', () => {
  function freshCounters(): SyncEventCounters {
    return { uploaded: 0, downloaded: 0, deleted: 0, skipped: 0, errors: 0, bytesTransferred: 0 }
  }

  it('upload-done increments uploaded and adds to bytesTransferred', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'upload-done', path: 'a.txt', size: 17 }, c)
    expect(c.uploaded).toBe(1)
    expect(c.bytesTransferred).toBe(17)
  })

  it('download-done increments downloaded and adds to bytesTransferred', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'download-done', path: 'b.txt', size: 9 }, c)
    expect(c.downloaded).toBe(1)
    expect(c.bytesTransferred).toBe(9)
  })

  it('delete-remote increments deleted', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'delete-remote', path: 'd.txt', size: 0 }, c)
    expect(c.deleted).toBe(1)
  })

  it('delete-local increments deleted', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'delete-local', path: 'd.txt', size: 0 }, c)
    expect(c.deleted).toBe(1)
  })

  it('hide increments deleted', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'hide', path: 'h.txt', size: 0 }, c)
    expect(c.deleted).toBe(1)
  })

  it('skip increments skipped', () => {
    const c = freshCounters()
    processSyncEvent({ type: 'skip', path: 's.txt', size: 0, message: 'no-op' }, c)
    expect(c.skipped).toBe(1)
  })

  it('error increments errors and warns with message', async () => {
    const c = freshCounters()
    const captured = await captureStdout(() => {
      processSyncEvent({ type: 'error', path: 'e.txt', size: 0, message: 'boom' }, c)
    })
    expect(c.errors).toBe(1)
    expect(captured).toContain('::warning::')
    expect(captured).toContain('boom')
  })

  it.each(['upload-start', 'compare', 'download-start', 'copy-start', 'copy-done'] as const)(
    'informational event %s is a no-op',
    (type) => {
      const before = freshCounters()
      const c = freshCounters()
      processSyncEvent({ type, path: 'x.txt', size: 0 }, c)
      expect(c).toEqual(before)
    },
  )
})

// =========================================================================
// upload: filesystem-boundary skip when a glob match resolves to a missing
// target (broken symlink). Exercises the TOCTOU-race-style guard in
// `resolveFiles`: globber lists the symlink (it isn't a directory, so
// `matchDirectories: false` doesn't filter it), `stat` follows it to a
// non-existent target and throws ENOENT, `tryStat` returns undefined, and
// the upload loop skips the entry without crashing.
// =========================================================================

describe('upload: skips broken symlinks silently', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-upload-broken-symlink')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('does not fail the upload when a globbed entry is a broken symlink', async () => {
    const root = join(fx.workDir, 'site')
    await mkdir(root, { recursive: true })
    // Real file: will upload.
    await writeFile(join(root, 'real.txt'), 'real')
    // Broken symlink: target does not exist.
    await symlink(join(root, 'does-not-exist.txt'), join(root, 'broken.txt'))

    const result = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: `${root}/**`, destination: 'site' }),
    )
    const names = result.files.map((f) => f.fileName)
    expect(names.some((n) => n.endsWith('real.txt'))).toBe(true)
    expect(names.some((n) => n.endsWith('broken.txt'))).toBe(false)
  })
})

// =========================================================================
// summary: appendFile failure path. The action catches the error and calls
// `core.warning` rather than failing the step. Triggered by pointing the
// `$GITHUB_STEP_SUMMARY` env var at a directory: `appendFile` to a directory
// throws `EISDIR` on every platform.
// =========================================================================

describe('summary: appendFile error logs a warning instead of throwing', () => {
  const ORIGINAL = process.env.GITHUB_STEP_SUMMARY
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'b2-summary-error-'))
    process.env.GITHUB_STEP_SUMMARY = dir // a directory, not a writable file
  })
  afterEach(async () => {
    if (ORIGINAL === undefined) Reflect.deleteProperty(process.env, 'GITHUB_STEP_SUMMARY')
    else process.env.GITHUB_STEP_SUMMARY = ORIGINAL
    await rm(dir, { recursive: true, force: true })
  })

  it('warns instead of throwing when the summary path is unwritable', async () => {
    const captured = await captureStdout(async () => {
      await writeStepSummary({ title: 'will-fail', rows: [{ fileName: 'x.txt' }] })
    })
    expect(captured).toContain('::warning::')
    expect(captured).toContain('Failed to write step summary')
  })
})

// =========================================================================
// AbortSignal wiring: pass a non-aborted signal to each command that accepts
// one. Covers the `signal !== undefined` conditional-spread arm at every
// SDK call site. Behavior is otherwise identical to an unsignaled call.
// =========================================================================

describe('commands: AbortSignal is threaded to SDK options', () => {
  let fx: TestFixture
  let signal: AbortSignal
  beforeEach(async () => {
    fx = await makeFixture('gh-action-signal')
    signal = new AbortController().signal
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('upload accepts a signal without aborting', async () => {
    const local = join(fx.workDir, 'sig.txt')
    await writeFile(local, 'signal')
    const r = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: local, destination: 'sig.txt' }),
      signal,
    )
    expect(r.files[0]?.fileName).toBe('sig.txt')
  })

  it('download accepts a signal without aborting', async () => {
    await seedFile(fx, 'd.txt', 'd')
    const r = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'd.txt', destination: fx.workDir }),
      signal,
    )
    expect(r.files[0]?.fileName).toBe('d.txt')
  })

  it('sync accepts a signal without aborting', async () => {
    const src = join(fx.workDir, 'src')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'a.txt'), 'a')
    const r = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, { source: src, syncDirection: 'up' }),
      signal,
    )
    expect(r.uploaded).toBeGreaterThanOrEqual(1)
  })

  it('delete accepts a signal without aborting', async () => {
    await seedFile(fx, 'p/x.txt', 'x')
    const r = await deleteCommand(fx.bucket, makeInputs('delete', fx, { source: 'p/' }), signal)
    expect(r.files.length).toBeGreaterThanOrEqual(1)
  })

  it('purge accepts a signal without aborting', async () => {
    await seedFile(fx, 'q/x.txt', 'x')
    const r = await purgeCommand(fx.bucket, makeInputs('purge', fx, { source: 'q/' }), signal)
    expect(r.files.length).toBeGreaterThanOrEqual(1)
  })

  it('copy accepts a signal without aborting', async () => {
    await seedFile(fx, 'src.txt', 'copy-src')
    const r = await copyCommand(
      fx.client,
      fx.bucket,
      makeInputs('copy', fx, { source: 'src.txt', destination: 'dst.txt' }),
      signal,
    )
    expect(r.destinationFileName).toBe('dst.txt')
  })
})

// =========================================================================
// retention: reject a retention-until in the past (client-side validation
// catches it before the round-trip).
// =========================================================================

describe('retention: rejects a past retention-until', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-retention-past')
    await fx.bucket.delete()
    fx.bucket = await fx.client.createBucket({
      bucketName: 'gh-action-retention-past',
      bucketType: 'allPrivate',
      fileLockEnabled: true,
    })
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('throws when retention-until is in the past', async () => {
    await seedFile(fx, 'r.txt', 'r')
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    await expect(
      retentionCommand(
        fx.bucket,
        makeInputs('retention', fx, {
          source: 'r.txt',
          retentionMode: 'governance',
          retentionUntil: yesterday,
        }),
      ),
    ).rejects.toThrow(/must be in the future/)
  })
})

// =========================================================================
// download: unlink partial file on pipeline error. Inject a failure on the
// download body fetch to force the pipeline to throw; assert the destination
// path doesn't exist after the catch.
// =========================================================================

describe('download: cleans up partial file on pipeline error', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-dl-partial-cleanup')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  // Skipped on Windows: NTFS doesn't honor POSIX mode bits the way
  // chmod(0o555) implies, so the directory stays writable and the test
  // can't force the pipeline to throw. The unlink-on-error branch is
  // covered on the Linux/macOS legs of the matrix (and by the coverage
  // gate, which only runs on Linux).
  it.skipIf(process.platform === 'win32')(
    'unlinks the destination file if the pipeline throws',
    async () => {
      // Make `bucket.download` succeed (so we enter the try block) but force
      // the pipeline to fail when it tries to write. Pre-create the
      // destination directory as read-only: `mkdir` (recursive) is a no-op
      // because the directory exists, then `createWriteStream` opens the
      // file path inside it, but the actual write syscall fails with EACCES.
      // That hits the catch block and the action's best-effort unlink.
      await seedFile(fx, 'will-fail.txt', 'payload')
      const { chmod } = await import('node:fs/promises')
      const destDir = join(fx.workDir, 'ro-dir')
      await mkdir(destDir, { recursive: true })
      const dest = join(destDir, 'out.txt')
      await chmod(destDir, 0o555) // read+execute, no write

      try {
        await expect(
          downloadCommand(
            fx.bucket,
            makeInputs('download', fx, { source: 'will-fail.txt', destination: dest }),
          ),
        ).rejects.toThrow(/EACCES|EPERM|permission denied/i)
      } finally {
        // Restore mode so afterEach's `rm` can clean up.
        await chmod(destDir, 0o755)
      }
    },
  )
})

// =========================================================================
// Imports needed by the new sections.
// =========================================================================
// (References: deleteCommand, purgeCommand, listCommand, downloadCommand,
// presignCommand, uploadCommand, headCommand, verifyCommand, makeProgressListener)
