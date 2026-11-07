import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { FileAction } from '@backblaze-labs/b2-sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hideCommand } from '../../src/commands/hide.ts'
import { listCommand } from '../../src/commands/list.ts'
import { unhideCommand } from '../../src/commands/unhide.ts'
import { uploadCommand } from '../../src/commands/upload.ts'
import { verifyCommand } from '../../src/commands/verify.ts'
import { makeFixture, makeInputs, seedFile, type TestFixture } from '../_helpers.ts'

function inputs(action: Parameters<typeof makeInputs>[0], over: Record<string, unknown> = {}) {
  return makeInputs(action, { bucket: 'gh-action-listhide', ...over })
}

describe('list command', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-listhide')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('returns visible files under a prefix with metadata', async () => {
    for (const name of ['logs/a.txt', 'logs/b.txt', 'cache/c.txt']) {
      const local = join(fx.workDir, name.replace('/', '_'))
      await writeFile(local, name)
      await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: name }))
    }

    const result = await listCommand(fx.bucket, inputs('list', { source: 'logs/' }))
    expect(result.files.map((f) => f.fileName).sort()).toEqual(['logs/a.txt', 'logs/b.txt'])
    expect(result.files[0]?.size).toBeGreaterThan(0)
    expect(result.files[0]?.contentSha1).not.toBeNull()
    expect(result.prefixes).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('forwards delimiter grouping and returns virtual prefixes separately', async () => {
    await seedFile(fx, 'logs/root.txt', 'root')
    const originalPage = await fx.bucket.listFileNames({ prefix: 'logs/' })
    const uploaded = originalPage.files[0]
    if (uploaded === undefined) throw new Error('expected uploaded fixture')

    const listFileNames = vi.spyOn(fx.bucket, 'listFileNames').mockResolvedValue({
      ...originalPage,
      files: [{ ...uploaded, action: FileAction.Folder, fileName: 'logs/archive/' }, uploaded],
    })

    const result = await listCommand(
      fx.bucket,
      inputs('list', { source: 'logs/', delimiter: '/', maxResults: 2 }),
    )

    expect(listFileNames).toHaveBeenCalledWith({ prefix: 'logs/', pageSize: 2, delimiter: '/' })
    expect(result.files.map((file) => file.fileName)).toEqual(['logs/root.txt'])
    expect(result.prefixes).toEqual([{ prefix: 'logs/archive/' }])
    expect(result.truncated).toBe(false)
  })

  it('keeps delimiter grouping while probing for truncated entries', async () => {
    await seedFile(fx, 'logs/root.txt', 'root')
    const originalPage = await fx.bucket.listFileNames({ prefix: 'logs/' })
    const uploaded = originalPage.files[0]
    if (uploaded === undefined) throw new Error('expected uploaded fixture')
    const folder = { ...uploaded, action: FileAction.Folder, fileName: 'logs/archive/' }

    const listFileNames = vi
      .spyOn(fx.bucket, 'listFileNames')
      .mockResolvedValueOnce({ ...originalPage, files: [uploaded], nextFileName: folder.fileName })
      .mockResolvedValueOnce({ ...originalPage, files: [folder], nextFileName: null })

    const result = await listCommand(
      fx.bucket,
      inputs('list', { source: 'logs/', delimiter: '/', maxResults: 1 }),
    )

    expect(listFileNames).toHaveBeenNthCalledWith(2, {
      prefix: 'logs/',
      pageSize: 1000,
      startFileName: 'logs/archive/',
      delimiter: '/',
    })
    expect(result.truncated).toBe(true)
  })

  it('reports truncation when results hit max-results', async () => {
    for (let i = 0; i < 5; i++) {
      const local = join(fx.workDir, `f${i}.txt`)
      await writeFile(local, `body-${i}`)
      await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: `f${i}.txt` }))
    }
    const result = await listCommand(fx.bucket, inputs('list', { maxResults: 2 }))
    expect(result.files).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('does not report truncation when remaining pages contain only hide markers', async () => {
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
      await seedFile(fx, name, name)
    }
    await fx.bucket.hideFile('c.txt')
    await fx.bucket.hideFile('d.txt')

    const result = await listCommand(fx.bucket, inputs('list', { maxResults: 2 }))

    expect(result.files.map((f) => f.fileName)).toEqual(['a.txt', 'b.txt'])
    expect(result.truncated).toBe(false)
  })
})

describe('hide + unhide commands', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-listhide')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('hides a file (hide marker tops the version stack) then unhides it', async () => {
    const local = join(fx.workDir, 'masked.txt')
    await writeFile(local, 'visible')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'masked.txt' }))

    const hideResult = await hideCommand(fx.bucket, inputs('hide', { source: 'masked.txt' }))
    expect(hideResult.fileName).toBe('masked.txt')
    expect(hideResult.fileId).toBeTruthy()

    // After hide, the most recent version of `masked.txt` is a hide marker.
    // Real B2 surfaces it through `listFileNames` with `action: 'hide'`; the
    // action's `list.ts` filters these out with `if (f.action !== 'upload')`.
    const afterHide = await fx.bucket.listFileNames({ prefix: 'masked.txt' })
    const masked = afterHide.files.find((f) => f.fileName === 'masked.txt')
    expect(masked?.action).toBe('hide')

    const unhideResult = await unhideCommand(fx.bucket, inputs('unhide', { source: 'masked.txt' }))
    expect(unhideResult.removedMarkerFileId).toBeTruthy()

    const afterUnhide = await fx.bucket.listFileNames({ prefix: 'masked.txt' })
    expect(
      afterUnhide.files.some((f) => f.fileName === 'masked.txt' && f.action === 'upload'),
    ).toBe(true)
  })

  it('unhide is a no-op when nothing is hidden', async () => {
    const local = join(fx.workDir, 'visible.txt')
    await writeFile(local, 'unhidden-already')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'visible.txt' }))

    const r = await unhideCommand(fx.bucket, inputs('unhide', { source: 'visible.txt' }))
    expect(r.removedMarkerFileId).toBeNull()
  })
})

describe('verify command', () => {
  let fx: TestFixture
  beforeEach(async () => {
    fx = await makeFixture('gh-action-listhide')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('returns verified=true when local SHA-1 matches remote', async () => {
    const local = join(fx.workDir, 'ok.txt')
    await writeFile(local, 'consistent content')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'ok.txt' }))

    const result = await verifyCommand(
      fx.bucket,
      inputs('verify', { source: 'ok.txt', destination: local }),
    )
    expect(result.verified).toBe(true)
    expect(result.remoteSha1).not.toBeNull()
    expect(result.localSha1).toBe(result.remoteSha1)
  })

  it('returns verified=false when local content has drifted', async () => {
    const local = join(fx.workDir, 'drift.txt')
    await writeFile(local, 'first content')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'drift.txt' }))

    await writeFile(local, 'drifted content')
    const result = await verifyCommand(
      fx.bucket,
      inputs('verify', { source: 'drift.txt', destination: local }),
    )
    expect(result.verified).toBe(false)
    expect(result.reason).toMatch(/SHA-1 mismatch/)
  })

  it('returns verified=false when B2 reports none as the remote SHA-1', async () => {
    const local = join(fx.workDir, 'remote-none.txt')
    await writeFile(local, 'remote-none')
    await uploadCommand(
      fx.bucket,
      inputs('upload', { source: local, destination: 'remote-none.txt' }),
    )

    const originalHead = fx.bucket.head.bind(fx.bucket)
    fx.bucket.head = async (...args: Parameters<typeof fx.bucket.head>) => {
      const result = await originalHead(...args)
      return { ...result, headers: { ...result.headers, contentSha1: 'none' } }
    }

    const result = await verifyCommand(
      fx.bucket,
      inputs('verify', {
        source: 'remote-none.txt',
        expectedSha1: '0000000000000000000000000000000000000000',
      }),
    )

    expect(result.verified).toBe(false)
    expect(result.remoteSha1).toBe('none')
    expect(result.reason).toMatch(/reported "none"/)
  })

  it('returns verified=false when B2 reports an unverified remote SHA-1', async () => {
    const local = join(fx.workDir, 'remote-unverified.txt')
    await writeFile(local, 'remote-unverified')
    await uploadCommand(
      fx.bucket,
      inputs('upload', { source: local, destination: 'remote-unverified.txt' }),
    )

    const unverifiedSha1 = 'unverified:0000000000000000000000000000000000000000'
    const originalHead = fx.bucket.head.bind(fx.bucket)
    fx.bucket.head = async (...args: Parameters<typeof fx.bucket.head>) => {
      const result = await originalHead(...args)
      return { ...result, headers: { ...result.headers, contentSha1: unverifiedSha1 } }
    }

    const result = await verifyCommand(
      fx.bucket,
      inputs('verify', {
        source: 'remote-unverified.txt',
        expectedSha1: '0000000000000000000000000000000000000000',
      }),
    )

    expect(result.verified).toBe(false)
    expect(result.remoteSha1).toBe(unverifiedSha1)
    expect(result.reason).toContain(unverifiedSha1)
  })

  it('accepts an expected-sha1 literal without a local file', async () => {
    const local = join(fx.workDir, 'literal.txt')
    await writeFile(local, 'literal')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'literal.txt' }))

    // First fetch the real SHA-1 by running with the local file.
    const baseline = await verifyCommand(
      fx.bucket,
      inputs('verify', { source: 'literal.txt', destination: local }),
    )
    expect(baseline.verified).toBe(true)

    // Then verify again using only the literal.
    const literal = await verifyCommand(
      fx.bucket,
      inputs('verify', {
        source: 'literal.txt',
        expectedSha1: baseline.remoteSha1 ?? 'bogus',
      }),
    )
    expect(literal.verified).toBe(true)
    expect(literal.localSha1).toBeNull()
  })

  it('throws when neither destination nor expected-sha1 is given', async () => {
    const local = join(fx.workDir, 'needy.txt')
    await writeFile(local, 'needs-input')
    await uploadCommand(fx.bucket, inputs('upload', { source: local, destination: 'needy.txt' }))

    await expect(
      verifyCommand(fx.bucket, inputs('verify', { source: 'needy.txt' })),
    ).rejects.toThrow(/expected-sha1.*destination/)
  })
})
