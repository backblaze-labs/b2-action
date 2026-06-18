import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionName, ParsedInputs } from '../src/inputs.ts'
import { makeInputs } from './_helpers.ts'

const EXPECTED_OUTPUT_KEYS = {
  upload: [
    'bytes-transferred',
    'content-sha1',
    'file-count',
    'file-id',
    'file-name',
    'files-uploaded',
    'summary-json',
  ],
  download: [
    'bytes-transferred',
    'content-sha1',
    'file-count',
    'file-name',
    'files-downloaded',
    'summary-json',
  ],
  sync: [
    'bytes-transferred',
    'file-count',
    'files-deleted',
    'files-downloaded',
    'files-uploaded',
    'summary-json',
  ],
  copy: ['bytes-transferred', 'file-count', 'file-id', 'file-name', 'summary-json'],
  delete: ['file-count', 'files-deleted', 'summary-json'],
  presign: ['file-count', 'file-name', 'files-listed', 'presigned-url', 'summary-json'],
  list: ['file-count', 'files-listed', 'summary-json'],
  hide: ['file-count', 'file-id', 'file-name', 'summary-json'],
  unhide: ['file-count', 'file-id', 'file-name', 'summary-json'],
  verify: ['file-count', 'file-name', 'local-sha1', 'remote-sha1', 'summary-json', 'verified'],
  retention: ['file-count', 'file-id', 'file-name', 'summary-json'],
  head: ['bytes-transferred', 'content-sha1', 'file-count', 'file-id', 'file-name', 'summary-json'],
  purge: ['file-count', 'files-deleted', 'summary-json'],
} as const satisfies Record<ActionName, readonly string[]>

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('main output contract', () => {
  it.each(
    Object.keys(EXPECTED_OUTPUT_KEYS) as ActionName[],
  )('emits the golden output key set for %s', async (action) => {
    const keys = await captureOutputKeys(action)

    expect(keys).toEqual([...EXPECTED_OUTPUT_KEYS[action]].sort())
  })
})

async function captureOutputKeys(action: ActionName): Promise<string[]> {
  vi.resetModules()
  const signalListeners = snapshotSignalListeners()
  try {
    const ctx = mockDispatcherPath(action)
    const main = await import('../src/main.ts')

    // Current main.ts executes on import. If a future entrypoint guard removes
    // that import side effect, keep this contract test pointed at run().
    if (ctx.buildClient.mock.calls.length === 0) {
      await main.run()
    } else {
      await vi.waitFor(() => expect(ctx.writeStepSummary).toHaveBeenCalledTimes(1))
      await Promise.resolve()
    }

    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    return [...new Set(ctx.core.setOutput.mock.calls.map(([key]) => String(key)))].sort()
  } finally {
    restoreSignalListeners(signalListeners)
  }
}

function mockDispatcherPath(action: ActionName) {
  const core = {
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }
  const parseInputs = vi
    .fn<() => ParsedInputs>()
    .mockReturnValue(
      makeInputs(action, action === 'purge' ? { dryRun: true, allowBucketPurge: true } : {}),
    )
  const authorized = { client: { kind: 'client' }, bucketName: 'gh-action-test' }
  const bucket = { name: 'gh-action-test' }
  const buildClient = vi.fn().mockResolvedValue(authorized)
  const getBucket = vi.fn().mockResolvedValue(bucket)
  const writeStepSummary = vi.fn().mockResolvedValue(undefined)
  const commands = commandMocks()

  applyCommandResult(commands, action)

  vi.doMock('@actions/core', () => core)
  vi.doMock('../src/inputs.ts', () => ({ parseInputs }))
  vi.doMock('../src/client.ts', () => ({ buildClient, getBucket }))
  vi.doMock('../src/summary.ts', () => ({ writeStepSummary }))
  vi.doMock('../src/commands/upload.ts', () => ({ uploadCommand: commands.uploadCommand }))
  vi.doMock('../src/commands/download.ts', () => ({ downloadCommand: commands.downloadCommand }))
  vi.doMock('../src/commands/sync.ts', () => ({
    syncCommand: commands.syncCommand,
    summarizeSyncErrors: commands.summarizeSyncErrors,
  }))
  vi.doMock('../src/commands/copy.ts', () => ({ copyCommand: commands.copyCommand }))
  vi.doMock('../src/commands/delete.ts', () => ({ deleteCommand: commands.deleteCommand }))
  vi.doMock('../src/commands/presign.ts', () => ({ presignCommand: commands.presignCommand }))
  vi.doMock('../src/commands/list.ts', () => ({ listCommand: commands.listCommand }))
  vi.doMock('../src/commands/hide.ts', () => ({ hideCommand: commands.hideCommand }))
  vi.doMock('../src/commands/unhide.ts', () => ({ unhideCommand: commands.unhideCommand }))
  vi.doMock('../src/commands/verify.ts', () => ({ verifyCommand: commands.verifyCommand }))
  vi.doMock('../src/commands/retention.ts', () => ({
    retentionCommand: commands.retentionCommand,
  }))
  vi.doMock('../src/commands/head.ts', () => ({ headCommand: commands.headCommand }))
  vi.doMock('../src/commands/purge.ts', () => ({ purgeCommand: commands.purgeCommand }))

  return { core, buildClient, writeStepSummary }
}

function commandMocks() {
  return {
    uploadCommand: vi.fn(),
    downloadCommand: vi.fn(),
    syncCommand: vi.fn(),
    summarizeSyncErrors: vi.fn(() => 'sample'),
    copyCommand: vi.fn(),
    deleteCommand: vi.fn(),
    presignCommand: vi.fn(),
    listCommand: vi.fn(),
    hideCommand: vi.fn(),
    unhideCommand: vi.fn(),
    verifyCommand: vi.fn(),
    retentionCommand: vi.fn(),
    headCommand: vi.fn(),
    purgeCommand: vi.fn(),
  }
}

function applyCommandResult(commands: ReturnType<typeof commandMocks>, action: ActionName): void {
  const file = fileResult(action)

  switch (action) {
    case 'upload':
      commands.uploadCommand.mockResolvedValue({ files: [file], bytesTransferred: file.size })
      return
    case 'download':
      commands.downloadCommand.mockResolvedValue({ files: [file], bytesTransferred: file.size })
      return
    case 'sync':
      commands.syncCommand.mockResolvedValue({
        events: [],
        direction: 'local-to-b2',
        uploaded: 1,
        downloaded: 0,
        deleted: 0,
        skipped: 0,
        errors: 0,
        bytesTransferred: file.size,
      })
      return
    case 'copy':
      commands.copyCommand.mockResolvedValue({
        fileId: file.fileId,
        sourceBucket: 'source-bucket',
        sourceFileName: 'source.txt',
        destinationBucket: 'gh-action-test',
        destinationFileName: file.fileName,
        size: file.size,
      })
      return
    case 'delete':
      commands.deleteCommand.mockResolvedValue({
        files: [{ fileName: file.fileName, fileId: file.fileId, skipped: false }],
        errors: 0,
      })
      return
    case 'presign':
      commands.presignCommand.mockResolvedValue({
        files: [
          { fileName: file.fileName, url: 'https://download.example/file.txt', expiresAt: 1 },
        ],
      })
      return
    case 'list':
      commands.listCommand.mockResolvedValue({ files: [file], truncated: false })
      return
    case 'hide':
      commands.hideCommand.mockResolvedValue(file)
      return
    case 'unhide':
      commands.unhideCommand.mockResolvedValue({
        fileName: file.fileName,
        removedMarkerFileId: file.fileId,
      })
      return
    case 'verify':
      commands.verifyCommand.mockResolvedValue({
        fileName: file.fileName,
        remoteSize: file.size,
        remoteSha1: file.contentSha1,
        localSha1: file.contentSha1,
        verified: true,
      })
      return
    case 'retention':
      commands.retentionCommand.mockResolvedValue({
        ...file,
        appliedMode: 'governance',
        retainUntilTimestamp: 1,
        appliedLegalHold: 'on',
      })
      return
    case 'head':
      commands.headCommand.mockResolvedValue(file)
      return
    case 'purge':
      commands.purgeCommand.mockResolvedValue({
        files: [{ fileName: file.fileName, fileId: file.fileId, skipped: false }],
        errors: 0,
      })
      return
  }
}

function fileResult(action: ActionName) {
  return {
    fileName: `${action}.txt`,
    fileId: `id-${action}`,
    size: 12,
    contentSha1: `sha1-${action}`,
    contentType: 'text/plain',
  }
}

const TEST_SIGNALS = ['SIGTERM', 'SIGINT'] as const

function snapshotSignalListeners() {
  return Object.fromEntries(TEST_SIGNALS.map((signal) => [signal, process.listeners(signal)]))
}

function restoreSignalListeners(snapshot: ReturnType<typeof snapshotSignalListeners>): void {
  for (const signal of TEST_SIGNALS) {
    const original = new Set(snapshot[signal])
    for (const listener of process.listeners(signal)) {
      if (!original.has(listener)) process.off(signal, listener)
    }
  }
}
