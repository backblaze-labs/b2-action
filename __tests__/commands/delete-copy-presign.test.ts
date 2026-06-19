import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyCommand } from '../../src/commands/copy.ts'
import { deleteCommand } from '../../src/commands/delete.ts'
import { presignCommand } from '../../src/commands/presign.ts'
import { uploadCommand } from '../../src/commands/upload.ts'
import type { ParsedInputs } from '../../src/inputs.ts'
import { captureFailure, makeFixture, makeInputs, seedFile, type TestFixture } from '../_helpers.ts'

function baseInputs(action: ParsedInputs['action']): ParsedInputs {
  return makeInputs(action, { bucket: 'gh-action-misc' })
}

describe('delete command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('deletes a single file by name', async () => {
    const local = join(fx.workDir, 'gone.txt')
    await writeFile(local, 'bye')
    await uploadCommand(fx.bucket, { ...baseInputs('upload'), source: local })

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'gone.txt',
    })

    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.fileName).toBe('gone.txt')
    expect(result.files[0]?.skipped).toBe(false)
  })

  it('dry-run reports what would be deleted without deleting', async () => {
    const local = join(fx.workDir, 'staying.txt')
    await writeFile(local, 'hi')
    await uploadCommand(fx.bucket, { ...baseInputs('upload'), source: local })

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'staying.txt',
      dryRun: true,
    })

    expect(result.files[0]?.skipped).toBe(true)

    const page = await fx.bucket.listFileNames({ prefix: 'staying.txt' })
    expect(page.files.some((f) => f.fileName === 'staying.txt' && f.action === 'upload')).toBe(true)
  })

  it('deletes all versions under a prefix', async () => {
    for (const name of ['p/a.txt', 'p/b.txt', 'q/c.txt']) {
      const local = join(fx.workDir, name.replace('/', '_'))
      await writeFile(local, name)
      await uploadCommand(fx.bucket, {
        ...baseInputs('upload'),
        source: local,
        destination: name,
      })
    }

    const result = await deleteCommand(fx.bucket, {
      ...baseInputs('delete'),
      source: 'p/',
    })

    expect(result.files.length).toBeGreaterThanOrEqual(2)
    expect(result.errors).toBe(0)
    const remaining = await fx.bucket.listFileNames({ prefix: '' })
    expect(remaining.files.some((f) => f.fileName === 'q/c.txt')).toBe(true)
    expect(remaining.files.some((f) => f.fileName.startsWith('p/'))).toBe(false)
  })

  it('throws when the file is not found', async () => {
    await expect(
      deleteCommand(fx.bucket, { ...baseInputs('delete'), source: 'nope.txt' }),
    ).rejects.toThrow(/not found/)
  })

  it('does not disclose hidden source existence in default dry-run logs', async () => {
    await seedFile(fx, 'private-delete.txt', 'secret')
    await fx.bucket.hideFile('private-delete.txt')

    const { error, stdout } = await captureFailure(() =>
      deleteCommand(fx.bucket, {
        ...baseInputs('delete'),
        source: 'private-delete.txt',
        dryRun: true,
      }),
    )

    expect(error.message).toBe(`File not found in bucket "${fx.bucket.name}": private-delete.txt`)
    expect(`${stdout}\n${error.message}`).not.toMatch(/File is hidden|hide marker|latest version/)
  })
})

describe('copy command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('server-side copies a small file', async () => {
    const local = join(fx.workDir, 'src.txt')
    await writeFile(local, 'copy me')
    await uploadCommand(fx.bucket, {
      ...baseInputs('upload'),
      source: local,
      destination: 'src.txt',
    })

    const result = await copyCommand(fx.client, fx.bucket, {
      ...baseInputs('copy'),
      source: 'src.txt',
      destination: 'archive/src.txt',
    })

    expect(result.destinationFileName).toBe('archive/src.txt')
    expect(result.fileId).toBeTruthy()
    expect(result.size).toBe(7)

    const remaining = await fx.bucket.listFileNames({ prefix: '' })
    expect(remaining.files.some((f) => f.fileName === 'src.txt')).toBe(true)
    expect(remaining.files.some((f) => f.fileName === 'archive/src.txt')).toBe(true)
  })

  it('errors when source is missing', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'missing.txt',
        destination: 'wherever.txt',
      }),
    ).rejects.toThrow(/File not found/)
  })

  it('does not disclose hidden source existence in default logs', async () => {
    await seedFile(fx, 'private-copy.txt', 'secret')
    await fx.bucket.hideFile('private-copy.txt')

    const { error, stdout } = await captureFailure(() =>
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'private-copy.txt',
        destination: 'copy-target.txt',
      }),
    )

    expect(error.message).toBe(`File not found in bucket "${fx.bucket.name}": private-copy.txt`)
    expect(`${stdout}\n${error.message}`).not.toMatch(/File is hidden|hide marker|latest version/)
  })

  it('errors when destination is missing', async () => {
    await expect(
      copyCommand(fx.client, fx.bucket, {
        ...baseInputs('copy'),
        source: 'whatever.txt',
      }),
    ).rejects.toThrow(/'destination' input is required/)
  })
})

describe('presign command', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-misc')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('returns a URL that points at the file', async () => {
    const local = join(fx.workDir, 'shareable.txt')
    await writeFile(local, 'share me')
    await uploadCommand(fx.bucket, {
      ...baseInputs('upload'),
      source: local,
      destination: 'shareable.txt',
    })

    const result = await presignCommand(fx.client, fx.bucket, {
      ...baseInputs('presign'),
      source: 'shareable.txt',
      presignTtlSeconds: 120,
    })

    expect(result.files).toHaveLength(1)
    const first = result.files[0]
    expect(first?.fileName).toBe('shareable.txt')
    expect(first?.url).toContain('/file/gh-action-misc/shareable.txt')
    expect(first?.url).toContain('Authorization=')
    expect(first?.url).toContain('expires=')
    expect(first?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })
})
