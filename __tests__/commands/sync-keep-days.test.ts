import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { syncCommand } from '../../src/commands/sync.ts'
import { boundInputs, makeFixture, type TestFixture } from '../_helpers.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `keep-mode: keep-days` retains destination-only files younger than the
 * window and removes the rest. The action previously never forwarded a window
 * to the SDK, which defaults it to 0 and therefore deleted every orphan
 * immediately, making the mode indistinguishable from `delete`.
 */
describe('sync command (keep-mode: keep-days)', () => {
  let fx: TestFixture
  const inputs = boundInputs('sync', () => fx)

  beforeEach(async () => {
    fx = await makeFixture(`gh-action-keep-days-${process.hrtime.bigint()}`)
    await mkdir(join(fx.workDir, 'local'), { recursive: true })
    await writeFile(join(fx.workDir, 'local', 'kept.txt'), 'in source')
  })
  afterEach(async () => {
    await rm(fx.workDir, { recursive: true, force: true })
  })

  async function seedLocalOrphan(name: string, ageDays: number): Promise<string> {
    const path = join(fx.workDir, 'dest', name)
    await mkdir(join(fx.workDir, 'dest'), { recursive: true })
    await writeFile(path, 'orphan')
    const when = new Date(Date.now() - ageDays * DAY_MS)
    await utimes(path, when, when)
    return path
  }

  it('keeps a destination-only file that is younger than keep-days', async () => {
    await seedLocalOrphan('young.txt', 2)
    const r = await syncCommand(
      fx.bucket,
      inputs({
        source: 'empty-prefix/',
        destination: join(fx.workDir, 'dest'),
        syncDirection: 'down',
        keepMode: 'keep-days',
        keepDays: 30,
      }),
    )
    expect(r.deleted).toBe(0)
    expect(r.skipped).toBe(1)
  })

  it('removes a destination-only file that is older than keep-days', async () => {
    await seedLocalOrphan('old.txt', 45)
    const r = await syncCommand(
      fx.bucket,
      inputs({
        source: 'empty-prefix/',
        destination: join(fx.workDir, 'dest'),
        syncDirection: 'down',
        keepMode: 'keep-days',
        keepDays: 30,
      }),
    )
    expect(r.deleted).toBe(1)
  })

  it('deletes immediately when keep-mode is delete, regardless of age', async () => {
    await seedLocalOrphan('young.txt', 2)
    const r = await syncCommand(
      fx.bucket,
      inputs({
        source: 'empty-prefix/',
        destination: join(fx.workDir, 'dest'),
        syncDirection: 'down',
        keepMode: 'delete',
      }),
    )
    expect(r.deleted).toBe(1)
  })
})
