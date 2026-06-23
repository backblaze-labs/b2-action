import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { headCommand } from '../../src/commands/head.ts'
import { hideCommand } from '../../src/commands/hide.ts'
import { unhideCommand } from '../../src/commands/unhide.ts'
import { tryStat } from '../../src/fs.ts'
import { captureStdout, makeFixture, makeInputs, seedFile, type TestFixture } from '../_helpers.ts'

// These tests pin the user-visible log surface (group labels + info lines) and
// the missing-source error wording for the small command wrappers, plus the
// tryStat error-swallowing contract. They exist to keep mutation coverage on
// code that is otherwise only exercised for its return value.
describe('head/hide/unhide log + error surface', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-logs')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('head: groups the probe and logs size/type/sha1', async () => {
    await seedFile(fx, 'h.txt', 'head-me')
    let result: Awaited<ReturnType<typeof headCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await headCommand(fx.bucket, makeInputs('head', fx, { source: 'h.txt' }))
    })
    expect(result?.contentSha1).toBeTruthy()
    expect(out).toContain('::group::head b2://gh-action-logs/h.txt')
    expect(out).toContain(
      `size=${result?.size} type=${result?.contentType} sha1=${result?.contentSha1}`,
    )
    expect(out).toContain('::endgroup::')
  })

  it('head: requires a source and names the action in the error', async () => {
    await expect(headCommand(fx.bucket, makeInputs('head', fx))).rejects.toThrow(
      "'source' input is required for 'head' action (the B2 file name)",
    )
  })

  it('hide: groups the call and logs the created marker', async () => {
    await seedFile(fx, 'g.txt', 'hide-me')
    let result: Awaited<ReturnType<typeof hideCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await hideCommand(fx.bucket, makeInputs('hide', fx, { source: 'g.txt' }))
    })
    expect(out).toContain('::group::hide b2://gh-action-logs/g.txt')
    expect(out).toContain(`hidden: g.txt (marker fileId=${result?.fileId})`)
    expect(out).toContain('::endgroup::')
  })

  it('hide: requires a source and names the action in the error', async () => {
    await expect(hideCommand(fx.bucket, makeInputs('hide', fx))).rejects.toThrow(
      "'source' input is required for 'hide' action (the B2 file name)",
    )
  })

  it('unhide: logs the removed marker when one exists', async () => {
    await seedFile(fx, 'u.txt', 'unhide-me')
    await fx.bucket.hideFile('u.txt')
    let result: Awaited<ReturnType<typeof unhideCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await unhideCommand(fx.bucket, makeInputs('unhide', fx, { source: 'u.txt' }))
    })
    expect(result?.removedMarkerFileId).toEqual(expect.any(String))
    expect(out).toContain('::group::unhide b2://gh-action-logs/u.txt')
    expect(out).toContain(
      `removed hide marker fileId=${result?.removedMarkerFileId}, u.txt is now visible`,
    )
  })

  it('unhide: reports a no-op when there is no hide marker', async () => {
    await seedFile(fx, 'v.txt', 'visible')
    let result: Awaited<ReturnType<typeof unhideCommand>> | undefined
    const out = await captureStdout(async () => {
      result = await unhideCommand(fx.bucket, makeInputs('unhide', fx, { source: 'v.txt' }))
    })
    expect(result?.removedMarkerFileId).toBeNull()
    expect(out).toContain('no hide marker found for v.txt (already visible or non-existent)')
  })

  it('unhide: requires a source and names the action in the error', async () => {
    await expect(unhideCommand(fx.bucket, makeInputs('unhide', fx))).rejects.toThrow(
      "'source' input is required for 'unhide' action (the B2 file name)",
    )
  })
})

describe('tryStat', () => {
  let fx: TestFixture

  beforeEach(async () => {
    fx = await makeFixture('gh-action-try-stat')
  })

  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  it('returns Stats for an existing path', async () => {
    const p = join(fx.workDir, 'present.txt')
    await writeFile(p, 'x')
    const s = await tryStat(p)
    expect(s?.isFile()).toBe(true)
  })

  it('returns undefined instead of throwing for a missing path', async () => {
    const s = await tryStat(join(fx.workDir, 'does', 'not', 'exist.txt'))
    expect(s).toBeUndefined()
  })
})
