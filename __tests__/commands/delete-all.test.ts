import type { Bucket } from '@backblaze-labs/b2-sdk'
import { describe, expect, it, vi } from 'vitest'
import { type DeleteAllVersionsEvent, deleteAllVersions } from '../../src/commands/delete-all.ts'

describe('deleteAllVersions', () => {
  it('does not delete listed versions outside the requested prefix', async () => {
    const deleteFileVersion = vi.fn()
    const bucket = bucketWith([fileVersion('other/locked.txt', 'id-out')], deleteFileVersion)

    const events = await collect(
      deleteAllVersions(bucket, {
        prefix: 'safe/',
        dryRun: false,
        bypassGovernance: true,
      }),
    )

    expect(deleteFileVersion).not.toHaveBeenCalled()
    expect(events).toEqual([
      {
        type: 'error',
        fileName: 'other/locked.txt',
        fileId: 'id-out',
        message: 'listed file is outside requested prefix',
      },
    ])
  })

  it('stops before issuing another delete after cancellation', async () => {
    const deleteFileVersion = vi.fn(async () => undefined)
    const bucket = bucketWith(
      [fileVersion('p/one.txt', 'id-1'), fileVersion('p/two.txt', 'id-2')],
      deleteFileVersion,
    )
    const controller = new AbortController()
    const events: DeleteAllVersionsEvent[] = []

    await expect(async () => {
      for await (const event of deleteAllVersions(bucket, {
        prefix: 'p/',
        dryRun: false,
        bypassGovernance: true,
        signal: controller.signal,
      })) {
        events.push(event)
        controller.abort(new Error('stop after first'))
      }
    }).rejects.toThrow('stop after first')

    expect(events).toHaveLength(1)
    expect(deleteFileVersion).toHaveBeenCalledTimes(1)
    expect(deleteFileVersion).toHaveBeenCalledWith('p/one.txt', 'id-1', {
      bypassGovernance: true,
    })
  })

  it('propagates cancellation from an in-flight delete', async () => {
    const controller = new AbortController()
    const abortReason = new Error('cancelled during delete')
    const deleteFileVersion = vi.fn(async () => {
      controller.abort(abortReason)
      throw abortReason
    })
    const bucket = bucketWith([fileVersion('p/one.txt', 'id-1')], deleteFileVersion)
    const events: DeleteAllVersionsEvent[] = []

    await expect(async () => {
      for await (const event of deleteAllVersions(bucket, {
        prefix: 'p/',
        dryRun: false,
        bypassGovernance: true,
        signal: controller.signal,
      })) {
        events.push(event)
      }
    }).rejects.toThrow('cancelled during delete')

    expect(events).toEqual([])
    expect(deleteFileVersion).toHaveBeenCalledTimes(1)
  })
})

async function collect(
  events: AsyncGenerator<DeleteAllVersionsEvent>,
): Promise<DeleteAllVersionsEvent[]> {
  const collected: DeleteAllVersionsEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

function bucketWith(
  versions: ReturnType<typeof fileVersion>[],
  deleteFileVersion: ReturnType<typeof vi.fn>,
): Bucket {
  return {
    name: 'unit-test-bucket',
    paginateFileVersions: vi.fn(async function* () {
      for (const version of versions) yield version
    }),
    deleteFileVersion,
  } as unknown as Bucket
}

function fileVersion(fileName: string, fileId: string) {
  return {
    fileName,
    fileId,
    action: 'upload',
  }
}
