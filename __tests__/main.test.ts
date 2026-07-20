import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  AccessDeniedError,
  B2Error,
  B2SsrfError,
  BadAuthTokenError,
  NetworkError,
  ServiceUnavailableError,
} from '@backblaze-labs/b2-sdk/errors'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BucketCommandResult } from '../src/commands/buckets.ts'
import type { DownloadedFile } from '../src/commands/download.ts'
import type { ListedFile } from '../src/commands/list.ts'
import type { UploadedFile } from '../src/commands/upload.ts'
import type { ActionName, ParsedInputs } from '../src/inputs.ts'
import {
  SUMMARY_JSON_MAX_UTF8_BYTES,
  SUMMARY_JSON_NOTICE_OUTPUT_NAME,
  SUMMARY_JSON_PREVIEW_MAX_ENTRIES,
  SUMMARY_JSON_PREVIEW_OUTPUT_NAME,
} from '../src/outputs.ts'
import type * as Summary from '../src/summary.ts'
import {
  makeParsedInputs,
  TEST_APPLICATION_KEY,
  TEST_APPLICATION_KEY_ID,
  TEST_ENDPOINT,
} from './_parsed-inputs.ts'

type LoadedMain = Awaited<ReturnType<typeof loadMain>>

const DISPATCH_BUCKET = 'dispatch-bucket'
const TEST_AUTH_TOKEN = 'auth-token-for-main-tests'
const RETAIN_UNTIL = Date.parse('2030-01-01T00:00:00Z')
const FIXTURE_UPLOAD_TS = Date.parse('2026-01-01T00:00:00Z')
// This file mocks src/summary.ts before importing main.ts, so use a named
// fixture cap instead of importing the real module as a value here.
const TEST_STEP_SUMMARY_MAX_ROWS = 100

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

describe('main dispatcher', () => {
  it('detects whether the module is the executed entrypoint', async () => {
    const { isEntrypoint } = await loadMain()
    const mainUrl = new URL('../src/main.ts', import.meta.url)

    expect(isEntrypoint(mainUrl.href, fileURLToPath(mainUrl))).toBe(true)
    expect(isEntrypoint(mainUrl.href, '/tmp/other.js')).toBe(false)
    expect(isEntrypoint(mainUrl.href, undefined)).toBe(false)

    const tempDir = await mkdtemp(join(tmpdir(), 'b2-entrypoint-'))
    try {
      const realDir = join(tempDir, 'real')
      const linkDir = join(tempDir, 'link')
      const realEntrypoint = join(realDir, 'index.js')
      await mkdir(realDir)
      await writeFile(realEntrypoint, '')
      await symlink(realDir, linkDir)

      expect(isEntrypoint(pathToFileURL(realEntrypoint).href, join(linkDir, 'index.js'))).toBe(true)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it.each([
    'upload',
    'download',
    'sync',
    'copy',
    'delete',
    'presign',
    'list',
    'hide',
    'unhide',
    'verify',
    'retention',
    'head',
    'purge',
    'create-bucket',
    'delete-bucket',
    'list-buckets',
  ] satisfies ActionName[])('dispatches %s and emits its outputs', async (action) => {
    const ctx = await loadMain()
    const expectedOutputs = setupSuccessfulAction(ctx, action)

    await ctx.run()

    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(outputs(ctx)).toEqual(expectedOutputs)
    expect(ctx.writeStepSummary).toHaveBeenCalledTimes(1)
  })

  it('keeps large mutating results successful and caps upload summary rows', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: TEST_STEP_SUMMARY_MAX_ROWS + 50 }, (_, i) =>
      uploadedFile({
        fileName: `uploaded-${i}.txt`,
        fileId: `id-uploaded-${i}`,
        size: 1,
      }),
    )
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockResolvedValue({ files, bytesTransferred: files.length })

    await ctx.run()

    const out = outputs(ctx)
    const summary = firstSummary(ctx)
    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(out['files-uploaded']).toBe(String(files.length))
    expect(out['summary-json-truncated']).toBe('false')
    expect(JSON.parse(out['summary-json'] ?? '[]')).toHaveLength(files.length)
    expect(summary?.totalRows).toBe(files.length)
    expect(summary?.rows).toHaveLength(TEST_STEP_SUMMARY_MAX_ROWS)
    expect(summary?.rows?.at(-1)?.fileName).toBe('uploaded-99.txt')
  })

  it('surfaces upload fileInfo in summary-json', async () => {
    const ctx = await loadMain()
    const file = uploadedFile({
      fileName: 'metadata.txt',
      fileId: 'id-metadata',
      size: 7,
      fileInfo: { build_sha: 'abc123', 'b2-cache-control': 'public, max-age=31536000' },
    })
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockResolvedValue({ files: [file], bytesTransferred: file.size })

    await ctx.run()

    expect(JSON.parse(outputs(ctx)['summary-json'] ?? '[]')).toEqual([file])
  })

  it('passes endpoint only when the parsed input supplies one', async () => {
    const ctx = await loadMain()
    const files = [
      listedFile({
        fileName: 'endpoint.txt',
        fileId: 'id-endpoint',
        size: 12,
      }),
    ]
    ctx.parseInputs.mockReturnValue(inputs('list', { endpoint: TEST_ENDPOINT }))
    ctx.commands.listCommand.mockResolvedValue({ files, truncated: false })

    await ctx.run()

    expect(ctx.buildClient).toHaveBeenCalledWith({
      applicationKeyId: TEST_APPLICATION_KEY_ID,
      applicationKey: TEST_APPLICATION_KEY,
      bucket: DISPATCH_BUCKET,
      endpoint: TEST_ENDPOINT,
    })
  })

  it('renders copy summaries with source and destination URLs', async () => {
    const ctx = await loadMain()
    setupSuccessfulAction(ctx, 'copy')

    await ctx.run()

    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: copy',
      rows: [
        {
          fileName: 'b2://source-bucket/source.txt → b2://dispatch-bucket/copied.txt',
          size: 13,
          fileId: 'id-copy',
          status: 'copied (server-side)',
        },
      ],
    })
  })

  it('threads cancellation signals to command calls', async () => {
    const ctx = await loadMain()
    const file = uploadedFile({
      fileName: 'signal.txt',
      fileId: 'id-signal',
      size: 5,
      contentSha1: 'sha-signal',
    })
    let signal: AbortSignal | undefined
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockImplementation(async (_bucket, _inputs, commandSignal) => {
      signal = commandSignal
      // The handler is registered inside run() before dispatch, so these
      // synchronous emits are contained by the run() finally cleanup below.
      process.emit('SIGTERM')
      process.emit('SIGINT')
      return { files: [file], bytesTransferred: file.size }
    })

    await ctx.run()

    expect(signal?.aborted).toBe(true)
    expect(ctx.core.warning).toHaveBeenCalledWith(
      'Received SIGTERM; cancelling in-flight B2 operations.',
    )
    expect(ctx.core.warning).toHaveBeenCalledWith(
      'Received SIGINT; cancelling in-flight B2 operations.',
    )
  })

  it('reports a SIGTERM-triggered command abort through setFailed', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockImplementation(async (_bucket, _inputs, commandSignal) => {
      // The handler is registered inside run() before dispatch, so this
      // synchronous emit is contained by the run() finally cleanup.
      process.emit('SIGTERM')
      commandSignal?.throwIfAborted()
      throw new Error('SIGTERM handler did not abort the command signal')
    })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('SIGTERM received')
    expect(ctx.writeStepSummary).not.toHaveBeenCalled()
  })

  it('removes signal listeners after run completes', async () => {
    const ctx = await loadMain()
    const beforeSigterm = process.listenerCount('SIGTERM')
    const beforeSigint = process.listenerCount('SIGINT')
    setupSuccessfulAction(ctx, 'upload')

    await ctx.run()

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigterm)
    expect(process.listenerCount('SIGINT')).toBe(beforeSigint)
  })

  it('omits per-file outputs when upload returns no files', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockResolvedValue({ files: [], bytesTransferred: 0 })

    await ctx.run()

    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'files-uploaded': '0',
        'file-count': '0',
        'bytes-transferred': '0',
        'summary-json': '[]',
      }),
    )
  })

  it('omits SHA-1 outputs when command results have null SHA-1 values', async () => {
    const ctx = await loadMain()
    const file = uploadedFile({
      fileName: 'multipart.txt',
      fileId: 'id-multipart',
      size: 20,
      contentSha1: null,
    })
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockResolvedValue({ files: [file], bytesTransferred: file.size })

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'file-id': 'id-multipart',
        'file-name': 'multipart.txt',
        'files-uploaded': '1',
        'file-count': '1',
        'bytes-transferred': '20',
        'summary-json': JSON.stringify([file]),
      }),
    )
  })

  it('omits per-file outputs when download returns no files', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('download'))
    ctx.commands.downloadCommand.mockResolvedValue({ files: [], bytesTransferred: 0 })

    await ctx.run()

    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'files-downloaded': '0',
        'file-count': '0',
        'bytes-transferred': '0',
        'summary-json': '[]',
      }),
    )
  })

  it('omits download SHA-1 outputs when hashes are unavailable', async () => {
    const ctx = await loadMain()
    const file: DownloadedFile = {
      fileName: 'multipart.bin',
      localPath: '/tmp/multipart.bin',
      size: 20,
      contentSha1: null,
    }
    ctx.parseInputs.mockReturnValue(inputs('download'))
    ctx.commands.downloadCommand.mockResolvedValue({ files: [file], bytesTransferred: file.size })

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'file-name': 'multipart.bin',
        'files-downloaded': '1',
        'file-count': '1',
        'bytes-transferred': '20',
        'summary-json': JSON.stringify([file]),
      }),
    )
  })

  it('omits verify SHA-1 outputs when hashes are unavailable', async () => {
    const ctx = await loadMain()
    const result = {
      fileName: 'multipart.bin',
      remoteSize: 20,
      remoteSha1: null,
      localSha1: null,
      verified: true,
      reason: undefined,
    }
    ctx.parseInputs.mockReturnValue(inputs('verify'))
    ctx.commands.verifyCommand.mockResolvedValue(result)

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        verified: 'true',
        'file-name': 'multipart.bin',
        'file-count': '1',
        'summary-json': JSON.stringify([result]),
      }),
    )
  })

  it('omits head SHA-1 outputs when hashes are unavailable', async () => {
    const ctx = await loadMain()
    const result = listedFile({
      fileName: 'multipart-head.bin',
      fileId: 'id-head-multipart',
      size: 20,
      contentSha1: null,
    })
    ctx.parseInputs.mockReturnValue(inputs('head'))
    ctx.commands.headCommand.mockResolvedValue(result)

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'file-id': 'id-head-multipart',
        'file-name': 'multipart-head.bin',
        'file-count': '1',
        'bytes-transferred': '0',
        'summary-json': JSON.stringify([result]),
      }),
    )
  })

  it('marks unhide as a no-op when no hide marker was present', async () => {
    const ctx = await loadMain()
    const result = { fileName: 'visible.txt', removedMarkerFileId: null }
    ctx.parseInputs.mockReturnValue(inputs('unhide'))
    ctx.commands.unhideCommand.mockResolvedValue(result)

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'file-name': 'visible.txt',
        'file-count': '1',
        'summary-json': JSON.stringify([result]),
      }),
    )
    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: unhide',
      rows: [{ fileName: 'visible.txt', fileId: undefined, status: 'no-op (not hidden)' }],
    })
  })

  it('renders retention summaries when optional retention fields are absent', async () => {
    const ctx = await loadMain()
    const result = {
      fileName: 'unlocked.txt',
      fileId: 'id-unlocked',
      appliedMode: undefined,
      retainUntilTimestamp: null,
      appliedLegalHold: undefined,
    }
    ctx.parseInputs.mockReturnValue(inputs('retention'))
    ctx.commands.retentionCommand.mockResolvedValue(result)

    await ctx.run()

    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: retention',
      rows: [{ fileName: 'unlocked.txt', fileId: 'id-unlocked', status: 'mode=-' }],
    })
  })

  it('renders retention summaries with retain-until and legal-hold details', async () => {
    const ctx = await loadMain()
    const result = {
      fileName: 'locked.txt',
      fileId: 'id-locked',
      appliedMode: 'governance',
      retainUntilTimestamp: RETAIN_UNTIL,
      appliedLegalHold: 'on',
    }
    ctx.parseInputs.mockReturnValue(inputs('retention'))
    ctx.commands.retentionCommand.mockResolvedValue(result)

    await ctx.run()

    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: retention',
      rows: [
        {
          fileName: 'locked.txt',
          fileId: 'id-locked',
          status: `mode=governance until=${new Date(RETAIN_UNTIL).toISOString()} legal-hold=on`,
        },
      ],
    })
  })

  it('renders dry-run b2-to-local sync summaries with download bytes', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('sync', { dryRun: true }))
    ctx.commands.syncCommand.mockResolvedValue({
      events: [],
      direction: 'b2-to-local',
      uploaded: 0,
      downloaded: 2,
      deleted: 0,
      skipped: 1,
      errors: 0,
      bytesTransferred: 30,
    })

    await ctx.run()

    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: sync (dry-run) [b2-to-local]',
      totals: { files: 2, bytes: 30 },
      rows: [
        { fileName: '(uploaded)', size: 0, status: '0' },
        { fileName: '(downloaded)', size: 30, status: '2' },
        { fileName: '(removed)', status: '0' },
        { fileName: '(unchanged)', status: '1' },
      ],
    })
  })

  it('renders delete dry-run summaries', async () => {
    const ctx = await loadMain()
    const files = [{ fileName: 'preview.txt', fileId: 'id-preview', skipped: true }]
    ctx.parseInputs.mockReturnValue(inputs('delete', { dryRun: true }))
    ctx.commands.deleteCommand.mockResolvedValue({ files, errors: 0 })

    await ctx.run()

    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: delete (dry-run)',
      totals: { files: 1, bytes: 0 },
      rows: [{ fileName: 'preview.txt', fileId: 'id-preview', status: 'would delete' }],
    })
  })

  it('caps delete summary rows while counting every file', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: 150 }, (_, i) => ({
      fileName: `d${i}.txt`,
      fileId: `id-${i}`,
      skipped: false,
    }))
    ctx.parseInputs.mockReturnValue(inputs('delete'))
    ctx.commands.deleteCommand.mockResolvedValue({ files, errors: 0 })

    await ctx.run()

    const summary = firstSummary(ctx)
    expect(summary).toMatchObject({
      title: 'Backblaze B2: delete',
      totals: { files: 150, bytes: 0 },
      totalRows: 150,
    })
    expect(summary?.rows).toHaveLength(TEST_STEP_SUMMARY_MAX_ROWS)
    expect(summary?.rows?.at(-1)).toEqual({
      fileName: 'd99.txt',
      fileId: 'id-99',
      status: 'deleted',
    })
  })

  it('omits presign per-file outputs when no URLs are generated', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('presign'))
    ctx.commands.presignCommand.mockResolvedValue({ files: [] })

    await ctx.run()

    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'files-listed': '0',
        'file-count': '0',
        'summary-json': '[]',
      }),
    )
  })

  it('caps presign summary rows with the standard row-count disclosure', async () => {
    const ctx = await loadMain()
    const baseExpiry = 1_900_000_000
    const files = Array.from({ length: TEST_STEP_SUMMARY_MAX_ROWS + 20 }, (_, i) => ({
      fileName: `signed-${i}.txt`,
      url: `https://signed.example/${i}`,
      expiresAt: baseExpiry + i,
    }))
    ctx.parseInputs.mockReturnValue(inputs('presign'))
    ctx.commands.presignCommand.mockResolvedValue({ files })

    await ctx.run()

    const summary = firstSummary(ctx)
    expect(summary).toMatchObject({
      title: `Backblaze B2: presign (${files.length})`,
      totalRows: files.length,
    })
    expect(summary?.rows).toHaveLength(TEST_STEP_SUMMARY_MAX_ROWS)
    expect(summary?.rows?.[0]).toEqual({
      fileName: 'signed-0.txt',
      status: `expires at ${new Date(baseExpiry * 1000).toISOString()}`,
    })
    expect(summary?.rows?.at(-1)).toEqual({
      fileName: 'signed-99.txt',
      status: `expires at ${new Date((baseExpiry + 99) * 1000).toISOString()}`,
    })
  })

  it('omits presign URLs from complete summary-json output', async () => {
    const ctx = await loadMain()
    const url = 'https://signed.example/file?Authorization=secret-token'
    const files = [{ fileName: 'signed.txt', url, expiresAt: 1_900_000_000 }]
    ctx.parseInputs.mockReturnValue(inputs('presign'))
    ctx.commands.presignCommand.mockResolvedValue({ files })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(out['presigned-url']).toBe(url)
    expect(out['summary-json-truncated']).toBe('false')
    expect(out['summary-json']).not.toContain(url)
    expect(out['summary-json']).not.toContain('Authorization')
    expect(JSON.parse(out['summary-json'] ?? '[]')).toEqual([
      { fileName: 'signed.txt', expiresAt: 1_900_000_000 },
    ])
  })

  it('omits presign URLs from truncated summary-json previews', async () => {
    const ctx = await loadMain()
    const longName = `${'s'.repeat(Math.floor(SUMMARY_JSON_MAX_UTF8_BYTES / 2))}.txt`
    const files = Array.from({ length: 3 }, (_, i) => ({
      fileName: `signed-${i}-${longName}`,
      url: `https://signed.example/file-${i}?Authorization=secret-token-${i}`,
      expiresAt: 1_900_000_000 + i,
    }))
    const first = files[0]
    if (first === undefined) throw new Error('expected presign fixture')
    ctx.parseInputs.mockReturnValue(inputs('presign'))
    ctx.commands.presignCommand.mockResolvedValue({ files })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(out['presigned-url']).toBe(first.url)
    expect(out['summary-json-truncated']).toBe('true')
    expect(out['summary-json']).toBe('[]')
    expect(out[SUMMARY_JSON_NOTICE_OUTPUT_NAME]).not.toContain('https://signed.example')
    expect(out[SUMMARY_JSON_NOTICE_OUTPUT_NAME]).not.toContain('Authorization')
    expect(out['summary-json']).not.toContain('https://signed.example')
    expect(out['summary-json']).not.toContain('Authorization')
    expect(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME]).not.toContain('https://signed.example')
    expect(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME]).not.toContain('Authorization')
    expect(JSON.parse(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME] ?? '[]')).toEqual([
      { fileName: first.fileName, expiresAt: first.expiresAt },
    ])
  })

  it('warns when list results are truncated and caps summary rows', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: 120 }, (_, i) =>
      listedFile({
        fileName: `listed-${i}.txt`,
        fileId: `id-listed-${i}`,
        size: 1,
      }),
    )
    ctx.parseInputs.mockReturnValue(inputs('list', { maxResults: 25 }))
    ctx.commands.listCommand.mockResolvedValue({ files, truncated: true })

    await ctx.run()

    expect(ctx.core.warning).toHaveBeenCalledWith(
      'list result truncated at max-results=25; raise it to see more',
    )
    const summary = firstSummary(ctx)
    expect(summary).toMatchObject({
      title: 'Backblaze B2: list (120+)',
      totals: { files: 120, bytes: 120 },
      totalRows: 120,
    })
    expect(summary?.rows).toHaveLength(TEST_STEP_SUMMARY_MAX_ROWS)
    expect(summary?.rows?.[0]).toMatchObject({
      fileName: 'listed-0.txt',
      fileId: 'id-listed-0',
      status: 'application/octet-stream',
    })
    expect(summary?.rows?.at(-1)).toMatchObject({
      fileName: 'listed-99.txt',
      fileId: 'id-listed-99',
      status: 'application/octet-stream',
    })
  })

  it('keeps successful results over the preview count non-fatal when summary-json fits', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5 }, (_, i) =>
      listedFile({
        fileName: `manifest-${i}.txt`,
        fileId: `id-manifest-${i}`,
        size: 1,
      }),
    )
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockResolvedValue({ files, truncated: false })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(out['summary-json-truncated']).toBe('false')
    expect(JSON.parse(out['summary-json'] ?? '[]')).toHaveLength(
      SUMMARY_JSON_PREVIEW_MAX_ENTRIES + 5,
    )
    expect(out).not.toHaveProperty(SUMMARY_JSON_PREVIEW_OUTPUT_NAME)
    expect(ctx.writeStepSummary).toHaveBeenCalledTimes(1)
  })

  it('emits a truncation notice without failing successful oversized results', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: 3 }, (_, i) =>
      listedFile({
        fileName: `huge-${i}-${'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES)}`,
        fileId: `id-huge-${i}`,
        size: 1,
      }),
    )
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockResolvedValue({ files, truncated: false })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).not.toHaveBeenCalled()
    expect(out['summary-json-truncated']).toBe('true')
    expect(JSON.parse(out['summary-json'] ?? 'null')).toEqual([])
    expect(JSON.parse(out[SUMMARY_JSON_NOTICE_OUTPUT_NAME] ?? '{}')).toMatchObject({
      truncated: true,
      totalCount: 3,
      previewOutput: SUMMARY_JSON_PREVIEW_OUTPUT_NAME,
    })
    expect(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME]).toBe('[]')
    expect(ctx.core.warning).toHaveBeenCalledWith(
      expect.stringContaining('summary-json-notice describes the truncation'),
    )
  })

  it('omits list truncation markers when results fit', async () => {
    const ctx = await loadMain()
    const files = [
      listedFile({
        fileName: 'a.txt',
        fileId: 'id-a',
        size: 1,
      }),
    ]
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockResolvedValue({ files, truncated: false })

    await ctx.run()

    expect(ctx.core.warning).not.toHaveBeenCalled()
    expect(firstSummary(ctx)).toMatchObject({
      title: 'Backblaze B2: list (1)',
      totals: { files: 1, bytes: 1 },
    })
  })

  it('reports parser/auth errors through setFailed', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockImplementation(() => {
      throw new Error('bad input')
    })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('bad input')
    expect(ctx.buildClient).not.toHaveBeenCalled()
  })

  it('scrubs sensitive raw inputs from parser failures', async () => {
    const ctx = await loadMain()
    const sseSecret = 'customer-key-secret'
    const rawSse = `C:${sseSecret}`
    ctx.core.getInput.mockImplementation((name) => (name === 'sse' ? rawSse : ''))
    ctx.parseInputs.mockImplementation(() => {
      throw new Error(`Invalid 'sse' input: "${rawSse}". Expected "B2".`)
    })

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    const debug = ctx.core.debug.mock.calls[0]?.[0]
    expect(failure).toContain('Invalid')
    expect(failure).not.toContain(rawSse)
    expect(failure).not.toContain(sseSecret)
    expect(debug).not.toContain(rawSse)
    expect(debug).not.toContain(sseSecret)
    expect(ctx.core.setSecret).toHaveBeenCalledWith(rawSse)
    expect(ctx.core.setSecret).toHaveBeenCalledWith(sseSecret)
    expect(ctx.buildClient).not.toHaveBeenCalled()
  })

  it('reports non-Error failures through setFailed', async () => {
    const ctx = await loadMain()
    const plainFailure = { toString: () => 'plain string' }
    ctx.parseInputs.mockImplementation(() => {
      throw plainFailure
    })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('plain string')
    expect(ctx.buildClient).not.toHaveBeenCalled()
  })

  it('emits retry outputs for classified SDK failures', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockRejectedValue(
      new ServiceUnavailableError(
        { status: 503, code: 'service_unavailable', message: 'try again later' },
        { retryAfter: 30, requestId: 'retry-request' },
      ),
    )

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith(
      'Transient B2 error: safe to retry this workflow. B2 response details: status 503, code service_unavailable, retry after 30s',
    )
    expect(outputs(ctx)).toMatchObject({
      retryable: 'true',
      'retry-after': '30',
    })
  })

  it('does not emit retryable=true or retry-after for mutating SDK failures', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('upload'))
    ctx.commands.uploadCommand.mockRejectedValue(
      new ServiceUnavailableError(
        { status: 503, code: 'service_unavailable', message: 'try again later' },
        { retryAfter: 30, requestId: 'retry-request' },
      ),
    )

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith(
      'Transient B2 error: the upload action may have partially committed; inspect B2 state before rerunning to avoid duplicate file versions, orphaned large-file uploads, or unintended deletes. B2 response details: status 503, code service_unavailable, retry after 30s',
    )
    expect(outputs(ctx)).toMatchObject({ retryable: 'false' })
    expect(outputs(ctx)).not.toHaveProperty('retry-after')
  })

  it('does not reflect masked secrets from SDK errors before setFailed', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockRejectedValue(
      new AccessDeniedError({
        status: 403,
        code: 'access_denied',
        message: `denied ${TEST_APPLICATION_KEY} ${TEST_AUTH_TOKEN}`,
      }),
    )

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    expect(failure).not.toContain(TEST_APPLICATION_KEY)
    expect(failure).not.toContain(TEST_AUTH_TOKEN)
  })

  it('registers auth tokens for runner log masking', async () => {
    const ctx = await loadMain()
    const rawAuthToken = ` ${TEST_AUTH_TOKEN} `
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.authorized.client.accountInfo.getAuthToken.mockReturnValue(rawAuthToken)
    ctx.commands.listCommand.mockResolvedValue({ files: [], truncated: false })

    await ctx.run()

    expect(ctx.core.setSecret).toHaveBeenCalledWith(rawAuthToken)
    expect(ctx.core.setSecret).toHaveBeenCalledWith(TEST_AUTH_TOKEN)
  })

  it('does not reflect auth tokens from buildClient failures', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.buildClient.mockRejectedValue(
      new AccessDeniedError({
        status: 403,
        code: 'access_denied',
        message: `authorize failed for ${TEST_AUTH_TOKEN}`,
      }),
    )

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    expect(failure).toBe(
      'B2 permission denied: check application key capabilities, bucket access, and file name prefix restrictions. B2 response details: status 403, code access_denied',
    )
    expect(failure).not.toContain(TEST_AUTH_TOKEN)
  })

  it('reports unauthorized scope errors as permission failures', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.buildClient.mockRejectedValue(
      new BadAuthTokenError({
        status: 401,
        code: 'unauthorized',
        message: 'Application key is missing capabilities: listFiles',
      }),
    )

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    expect(failure).toContain('B2 permission denied')
    expect(failure).not.toContain('B2 authentication failed')
  })

  it('reports endpoint safety errors without echoing raw URLs', async () => {
    const ctx = await loadMain()
    const rawUrl = 'http://user:password@169.254.169.254/latest/meta-data?token=secret'
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockRejectedValue(
      new B2SsrfError(`malformed URL from B2 response: ${rawUrl}`, rawUrl),
    )

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    expect(failure).toBe(
      'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.',
    )
    expect(failure).not.toContain(rawUrl)
    expect(failure).not.toContain('password')
    expect(failure).not.toContain('token=secret')
    expect(outputs(ctx)).toMatchObject({ retryable: 'false' })
  })

  it('reports wrapped endpoint safety errors without retry guidance', async () => {
    const ctx = await loadMain()
    const rawUrl = 'http://169.254.169.254/latest/meta-data'
    ctx.parseInputs.mockReturnValue(inputs('list'))
    ctx.commands.listCommand.mockRejectedValue(
      new NetworkError('fetch failed', new B2SsrfError(`blocked ${rawUrl}`, rawUrl)),
    )

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith(
      'B2 endpoint safety check failed: rejected an unsafe B2 endpoint or server-provided URL. Check the endpoint input and B2 realm configuration.',
    )
    expect(outputs(ctx)).toMatchObject({ retryable: 'false' })
    expect(outputs(ctx)).not.toHaveProperty('retry-after')
  })

  it('reports generic B2 failures with actionable detail and debug cause', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('download'))
    ctx.commands.downloadCommand.mockRejectedValue(
      new B2Error({
        status: 400,
        code: 'bad_request',
        message: 'invalid file name: reports//daily.csv',
      }),
    )

    await ctx.run()

    const failure = ctx.core.setFailed.mock.calls[0]?.[0]
    expect(failure).toContain('B2 request failed')
    expect(failure).toContain('Bad request')
    expect(failure).toContain('invalid file name: reports//daily.csv')
    expect(failure).toContain('status 400')
    expect(failure).toContain('code bad_request')
    expect(ctx.core.debug).toHaveBeenCalledWith(
      expect.stringContaining('invalid file name: reports//daily.csv'),
    )
  })

  it('reports sync aggregate errors with a sample', async () => {
    const ctx = await loadMain()
    ctx.parseInputs.mockReturnValue(inputs('sync'))
    ctx.commands.summarizeSyncErrors.mockReturnValue('remote.txt: denied')
    ctx.commands.syncCommand.mockResolvedValue({
      events: [{ type: 'error', path: 'remote.txt', message: 'denied', size: 0 }],
      direction: 'b2-to-local',
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      skipped: 0,
      errors: 1,
      bytesTransferred: 0,
    })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith(
      'Sync completed with 1 error(s): remote.txt: denied',
    )
  })

  it('preserves sync aggregate errors when summary-json is truncated', async () => {
    const ctx = await loadMain()
    const events = Array.from({ length: 3 }, (_, i) => ({
      type: i === 2 ? 'error' : 'skip',
      path: `remote-${i}.txt`,
      message: i === 2 ? `denied-${'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES)}` : undefined,
      size: 0,
    }))
    ctx.parseInputs.mockReturnValue(inputs('sync'))
    ctx.commands.summarizeSyncErrors.mockReturnValue('remote-2.txt: denied')
    ctx.commands.syncCommand.mockResolvedValue({
      events,
      direction: 'b2-to-local',
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      skipped: 3,
      errors: 1,
      bytesTransferred: 0,
    })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).toHaveBeenCalledWith(
      'Sync completed with 1 error(s): remote-2.txt: denied',
    )
    expect(out['summary-json-truncated']).toBe('true')
    expect(JSON.parse(out['summary-json'] ?? 'null')).toEqual([])
    expect(JSON.parse(out[SUMMARY_JSON_NOTICE_OUTPUT_NAME] ?? '{}')).toMatchObject({
      truncated: true,
      totalCount: events.length,
    })
    expect(JSON.parse(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME] ?? '[]')).toHaveLength(2)
  })

  it('reports failed verify results after publishing diagnostic outputs', async () => {
    const ctx = await loadMain()
    const result = {
      fileName: 'bad.bin',
      remoteSize: 8,
      remoteSha1: '0000000000000000000000000000000000000000',
      localSha1: 'local-sha',
      verified: false,
      reason: 'SHA-1 mismatch',
    }
    ctx.parseInputs.mockReturnValue(inputs('verify'))
    ctx.commands.verifyCommand.mockResolvedValue(result)

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('SHA-1 mismatch')
    expect(outputs(ctx)).toMatchObject({
      verified: 'false',
      'file-name': 'bad.bin',
      'remote-sha1': '0000000000000000000000000000000000000000',
      'local-sha1': 'local-sha',
    })
  })

  it('reports failed verify results with default diagnostics when reason is absent', async () => {
    const ctx = await loadMain()
    const result = {
      fileName: 'unknown.bin',
      remoteSize: 9,
      remoteSha1: '1111111111111111111111111111111111111111',
      localSha1: 'local-sha',
      verified: false,
      reason: undefined,
    }
    ctx.parseInputs.mockReturnValue(inputs('verify'))
    ctx.commands.verifyCommand.mockResolvedValue(result)

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('verify failed: SHA-1 mismatch')
    expect(ctx.writeStepSummary).toHaveBeenCalledWith({
      title: 'Backblaze B2: verify ✗',
      rows: [
        {
          fileName: 'unknown.bin',
          size: 9,
          sha1: '1111111111111111111111111111111111111111',
          status: 'mismatch',
        },
      ],
    })
  })

  it.each([
    {
      name: 'missing',
      remoteSha1: null,
      reason:
        'remote SHA-1 is unavailable because B2 does not expose a whole-file SHA-1 for multipart-uploaded files; HEAD-only verify cannot validate this object, even with expected-sha1',
    },
    {
      name: 'none',
      remoteSha1: 'none',
      reason:
        'remote SHA-1 is unavailable because B2 reported "none" instead of a verified 40-character whole-file SHA-1; HEAD-only verify cannot validate this object, even with expected-sha1',
    },
    {
      name: 'unverified',
      remoteSha1: 'unverified:0000000000000000000000000000000000000000',
      reason:
        'remote SHA-1 is unavailable because B2 reported "unverified:0000000000000000000000000000000000000000" instead of a verified 40-character whole-file SHA-1; HEAD-only verify cannot validate this object, even with expected-sha1',
    },
  ])('fails verify by default when the remote SHA-1 is $name', async ({ remoteSha1, reason }) => {
    const ctx = await loadMain()
    const result = {
      fileName: 'unverifiable.bin',
      remoteSize: 8,
      remoteSha1,
      localSha1: null,
      verified: false,
      reason,
    }
    ctx.parseInputs.mockReturnValue(inputs('verify'))
    ctx.commands.verifyCommand.mockResolvedValue(result)

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith(reason)
    expect(outputs(ctx)).toMatchObject({
      verified: 'false',
      'file-name': 'unverifiable.bin',
    })
    if (remoteSha1 === null) {
      expect(outputs(ctx)).not.toHaveProperty('remote-sha1')
    } else {
      expect(outputs(ctx)).toHaveProperty('remote-sha1', remoteSha1)
    }
  })

  it('reports deletion aggregate errors after publishing deletion outputs', async () => {
    const ctx = await loadMain()
    const files = [{ fileName: 'stuck.txt', fileId: 'id-stuck', skipped: false }]
    ctx.parseInputs.mockReturnValue(inputs('delete'))
    ctx.commands.deleteCommand.mockResolvedValue({ files, errors: 1 })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('Delete completed with 1 error(s)')
    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'files-deleted': '1',
        'file-count': '1',
        'summary-json': JSON.stringify(files),
      }),
    )
    expect(ctx.writeStepSummary).not.toHaveBeenCalled()
  })

  it('reports purge aggregate errors after publishing purge outputs', async () => {
    const ctx = await loadMain()
    const files = [{ fileName: 'stuck.txt', fileId: 'id-stuck', skipped: false }]
    ctx.parseInputs.mockReturnValue(inputs('purge', { allowBucketPurge: true }))
    ctx.commands.purgeCommand.mockResolvedValue({ files, errors: 2 })

    await ctx.run()

    expect(ctx.core.setFailed).toHaveBeenCalledWith('Purge completed with 2 error(s)')
    expect(outputs(ctx)).toEqual(
      completeSummaryOutput({
        'files-deleted': '1',
        'file-count': '1',
        'summary-json': JSON.stringify(files),
      }),
    )
    expect(ctx.writeStepSummary).not.toHaveBeenCalled()
  })

  it.each([
    ['delete', 'Delete', 1],
    ['purge', 'Purge', 2],
  ] as const)('preserves %s aggregate errors when summary-json is truncated', async (action, label, errors) => {
    const ctx = await loadMain()
    const files = Array.from({ length: 3 }, (_, i) => ({
      fileName: `stuck-${i}-${'x'.repeat(SUMMARY_JSON_MAX_UTF8_BYTES)}`,
      fileId: `id-stuck-${i}`,
      skipped: false,
    }))
    ctx.parseInputs.mockReturnValue(
      inputs(action, action === 'purge' ? { allowBucketPurge: true } : {}),
    )
    const command = action === 'delete' ? ctx.commands.deleteCommand : ctx.commands.purgeCommand
    command.mockResolvedValue({ files, errors })

    await ctx.run()

    const out = outputs(ctx)
    expect(ctx.core.setFailed).toHaveBeenCalledWith(`${label} completed with ${errors} error(s)`)
    expect(out).toMatchObject({
      'files-deleted': '3',
      'file-count': '3',
      'summary-json-truncated': 'true',
    })
    expect(JSON.parse(out['summary-json'] ?? 'null')).toEqual([])
    expect(JSON.parse(out[SUMMARY_JSON_NOTICE_OUTPUT_NAME] ?? '{}')).toMatchObject({
      truncated: true,
      totalCount: files.length,
    })
    expect(out[SUMMARY_JSON_PREVIEW_OUTPUT_NAME]).toBe('[]')
    expect(ctx.writeStepSummary).not.toHaveBeenCalled()
  })

  it('caps purge summary rows while counting every file', async () => {
    const ctx = await loadMain()
    const files = Array.from({ length: 150 }, (_, i) => ({
      fileName: `f${i}.txt`,
      fileId: `id-${i}`,
      skipped: false,
    }))
    ctx.parseInputs.mockReturnValue(inputs('purge', { allowBucketPurge: true }))
    ctx.commands.purgeCommand.mockResolvedValue({ files, errors: 0 })

    await ctx.run()

    const summary = firstSummary(ctx)
    expect(summary).toMatchObject({
      title: 'Backblaze B2: purge',
      totals: { files: 150, bytes: 0 },
      totalRows: 150,
    })
    expect(summary?.rows).toHaveLength(TEST_STEP_SUMMARY_MAX_ROWS)
    expect(summary?.rows?.[0]).toEqual({
      fileName: 'f0.txt',
      fileId: 'id-0',
      status: 'purged',
    })
    expect(summary?.rows?.at(-1)).toEqual({
      fileName: 'f99.txt',
      fileId: 'id-99',
      status: 'purged',
    })
  })
})

async function loadMain() {
  vi.resetModules()

  const core = {
    getInput: vi.fn<(name: string) => string>(() => ''),
    setOutput: vi.fn(),
    setFailed: vi.fn(),
    setSecret: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }
  const parseInputs = vi.fn<() => ParsedInputs>()
  const authorized = {
    client: {
      kind: 'client',
      accountInfo: { getAuthToken: vi.fn(() => TEST_AUTH_TOKEN) },
    },
    bucketName: DISPATCH_BUCKET,
  }
  const bucket = { name: DISPATCH_BUCKET }
  const buildClient = vi.fn<() => Promise<typeof authorized>>().mockResolvedValue(authorized)
  const getBucket = vi.fn<() => Promise<typeof bucket>>().mockResolvedValue(bucket)
  const writeStepSummary = vi.fn<typeof Summary.writeStepSummary>().mockResolvedValue(undefined)
  const commands = {
    createBucketCommand: vi.fn(),
    deleteBucketCommand: vi.fn(),
    listBucketsCommand: vi.fn(),
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

  vi.doMock('@actions/core', () => core)
  vi.doMock('../src/inputs.ts', async () => ({
    ...(await vi.importActual<typeof import('../src/inputs.ts')>('../src/inputs.ts')),
    parseInputs,
  }))
  vi.doMock('../src/client.ts', () => ({ buildClient, getBucket }))
  vi.doMock('../src/summary.ts', () => ({
    STEP_SUMMARY_MAX_ROWS: TEST_STEP_SUMMARY_MAX_ROWS,
    writeStepSummary,
  }))
  vi.doMock('../src/commands/buckets.ts', () => ({
    createBucketCommand: commands.createBucketCommand,
    deleteBucketCommand: commands.deleteBucketCommand,
    listBucketsCommand: commands.listBucketsCommand,
  }))
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

  const main = await importMainForTest()
  return {
    ...main,
    core,
    parseInputs,
    authorized,
    buildClient,
    getBucket,
    writeStepSummary,
    commands,
  }
}

async function importMainForTest() {
  const originalArgv1 = process.argv[1]
  const processOnce = vi
    .spyOn(process, 'once')
    .mockImplementation(
      ((..._args: Parameters<typeof process.once>) => process) as typeof process.once,
    )

  try {
    process.argv[1] = join(tmpdir(), 'vitest-main-test.js')
    return await import('../src/main.ts')
  } finally {
    if (originalArgv1 === undefined) {
      process.argv.splice(1, 1)
    } else {
      process.argv[1] = originalArgv1
    }
    processOnce.mockRestore()
  }
}

function setupSuccessfulAction(ctx: LoadedMain, action: ActionName): Record<string, string> {
  ctx.parseInputs.mockReturnValue(
    inputs(action, action === 'purge' ? { dryRun: true, allowBucketPurge: true } : {}),
  )

  switch (action) {
    case 'upload': {
      const file = uploadedFile({ fileName: 'upload.txt', fileId: 'id-upload', size: 10 })
      ctx.commands.uploadCommand.mockResolvedValue({ files: [file], bytesTransferred: 10 })
      return completeSummaryOutput({
        'file-id': 'id-upload',
        'file-name': 'upload.txt',
        'content-sha1': 'sha-upload.txt',
        'files-uploaded': '1',
        'file-count': '1',
        'bytes-transferred': '10',
        'summary-json': JSON.stringify([file]),
      })
    }
    case 'download': {
      const file = {
        fileName: 'download.txt',
        localPath: '/tmp/download.txt',
        size: 11,
        contentSha1: 'sha-download',
      }
      ctx.commands.downloadCommand.mockResolvedValue({ files: [file], bytesTransferred: 11 })
      return completeSummaryOutput({
        'file-name': 'download.txt',
        'content-sha1': 'sha-download',
        'files-downloaded': '1',
        'file-count': '1',
        'bytes-transferred': '11',
        'summary-json': JSON.stringify([file]),
      })
    }
    case 'sync': {
      const events = [{ type: 'upload-done', path: 'sync.txt', size: 12 }]
      ctx.commands.syncCommand.mockResolvedValue({
        events,
        direction: 'local-to-b2',
        uploaded: 1,
        downloaded: 0,
        deleted: 0,
        skipped: 2,
        errors: 0,
        bytesTransferred: 12,
      })
      return completeSummaryOutput({
        'files-uploaded': '1',
        'files-downloaded': '0',
        'files-deleted': '0',
        'file-count': '3',
        'bytes-transferred': '12',
        'summary-json': JSON.stringify(events),
      })
    }
    case 'copy': {
      const result = {
        sourceBucket: 'source-bucket',
        sourceFileName: 'source.txt',
        destinationBucket: DISPATCH_BUCKET,
        destinationFileName: 'copied.txt',
        fileId: 'id-copy',
        size: 13,
      }
      ctx.commands.copyCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'file-id': 'id-copy',
        'file-name': 'copied.txt',
        'file-count': '1',
        'bytes-transferred': '13',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'delete': {
      const files = [
        { fileName: 'deleted.txt', fileId: 'id-delete', skipped: false },
        { fileName: 'dry.txt', fileId: 'id-dry', skipped: true },
      ]
      ctx.commands.deleteCommand.mockResolvedValue({ files, errors: 0 })
      return completeSummaryOutput({
        'files-deleted': '1',
        'file-count': '2',
        'summary-json': JSON.stringify(files),
      })
    }
    case 'presign': {
      const files = [
        { fileName: 'signed.txt', url: 'https://signed.example/file', expiresAt: 1_900_000_000 },
      ]
      ctx.commands.presignCommand.mockResolvedValue({ files })
      return completeSummaryOutput({
        'presigned-url': 'https://signed.example/file',
        'file-name': 'signed.txt',
        'files-listed': '1',
        'file-count': '1',
        'summary-json': JSON.stringify([{ fileName: 'signed.txt', expiresAt: 1_900_000_000 }]),
      })
    }
    case 'list': {
      const files = [
        listedFile({
          fileName: 'listed.txt',
          fileId: 'id-list',
          size: 14,
          contentType: 'text/plain',
        }),
      ]
      ctx.commands.listCommand.mockResolvedValue({ files, truncated: true })
      return completeSummaryOutput({
        'files-listed': '1',
        'file-count': '1',
        'summary-json': JSON.stringify(files),
      })
    }
    case 'hide': {
      const result = { fileName: 'hidden.txt', fileId: 'id-hide' }
      ctx.commands.hideCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'file-id': 'id-hide',
        'file-name': 'hidden.txt',
        'file-count': '1',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'unhide': {
      const result = { fileName: 'visible.txt', removedMarkerFileId: 'id-marker' }
      ctx.commands.unhideCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'file-name': 'visible.txt',
        'file-id': 'id-marker',
        'file-count': '1',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'verify': {
      const result = {
        fileName: 'verified.txt',
        remoteSize: 15,
        remoteSha1: 'remote-sha',
        localSha1: 'local-sha',
        verified: true,
        reason: undefined,
      }
      ctx.commands.verifyCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        verified: 'true',
        'file-name': 'verified.txt',
        'file-count': '1',
        'remote-sha1': 'remote-sha',
        'local-sha1': 'local-sha',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'retention': {
      const result = {
        fileName: 'locked.txt',
        fileId: 'id-retention',
        appliedMode: 'governance',
        retainUntilTimestamp: RETAIN_UNTIL,
        appliedLegalHold: 'on',
      }
      ctx.commands.retentionCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'file-id': 'id-retention',
        'file-name': 'locked.txt',
        'file-count': '1',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'head': {
      const result = listedFile({
        fileName: 'head.txt',
        fileId: 'id-head',
        size: 16,
        contentSha1: 'sha-head',
      })
      ctx.commands.headCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'file-id': 'id-head',
        'file-name': 'head.txt',
        'content-sha1': 'sha-head',
        'file-count': '1',
        'bytes-transferred': '0',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'purge': {
      const files = [
        { fileName: 'purged.txt', fileId: 'id-purge', action: 'upload', skipped: false },
        { fileName: 'would.txt', fileId: 'id-would', action: 'skip', skipped: true },
      ]
      ctx.commands.purgeCommand.mockResolvedValue({ files, errors: 0 })
      return completeSummaryOutput({
        'files-deleted': '1',
        'file-count': '2',
        'summary-json': JSON.stringify(files),
      })
    }
    case 'create-bucket': {
      const result = bucketResult('created-bucket', 'id-create-bucket', 'allPrivate')
      ctx.commands.createBucketCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'bucket-id': 'id-create-bucket',
        'bucket-name': 'created-bucket',
        'bucket-type': 'allPrivate',
        'bucket-count': '1',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'delete-bucket': {
      const result = bucketResult('deleted-bucket', 'id-delete-bucket', 'allPublic')
      ctx.commands.deleteBucketCommand.mockResolvedValue(result)
      return completeSummaryOutput({
        'bucket-id': 'id-delete-bucket',
        'bucket-name': 'deleted-bucket',
        'bucket-type': 'allPublic',
        'bucket-count': '1',
        'summary-json': JSON.stringify([result]),
      })
    }
    case 'list-buckets': {
      const buckets = [
        bucketResult('bucket-a', 'id-bucket-a', 'allPrivate'),
        bucketResult('bucket-b', 'id-bucket-b', 'allPublic'),
      ]
      ctx.commands.listBucketsCommand.mockResolvedValue({ buckets })
      return completeSummaryOutput({
        'buckets-listed': '2',
        'bucket-count': '2',
        'summary-json': JSON.stringify(buckets),
      })
    }
  }
  const exhaustive: never = action
  throw new Error(`unhandled action: ${exhaustive}`)
}

function inputs(action: ActionName, override: Partial<ParsedInputs> = {}): ParsedInputs {
  return makeParsedInputs(action, {
    bucket: DISPATCH_BUCKET,
    source: 'source.txt',
    destination: 'dest.txt',
    ...override,
  })
}

function outputs(ctx: LoadedMain): Record<string, string> {
  return Object.fromEntries(
    ctx.core.setOutput.mock.calls.map(([key, value]) => [String(key), String(value)]),
  )
}

function completeSummaryOutput(outputs: Record<string, string>): Record<string, string> {
  return { ...outputs, 'summary-json-truncated': 'false' }
}

function firstSummary(ctx: LoadedMain): Parameters<typeof Summary.writeStepSummary>[0] | undefined {
  return ctx.writeStepSummary.mock.calls[0]?.[0]
}

function fileSha1(override: { fileName: string; contentSha1?: string | null }): string | null {
  // Preserve an explicit null instead of replacing it with the default test SHA.
  return 'contentSha1' in override ? (override.contentSha1 ?? null) : `sha-${override.fileName}`
}

function uploadedFile(override: {
  fileName: string
  fileId: string
  size: number
  contentSha1?: string | null
  fileInfo?: Record<string, string>
}): UploadedFile {
  return {
    localPath: `/tmp/${override.fileName}`,
    fileName: override.fileName,
    fileId: override.fileId,
    size: override.size,
    contentSha1: fileSha1(override),
    fileInfo: override.fileInfo ?? {},
  }
}

function listedFile(override: {
  fileName: string
  fileId: string
  size: number
  contentSha1?: string | null
  contentType?: string
}): ListedFile {
  return {
    fileName: override.fileName,
    fileId: override.fileId,
    size: override.size,
    contentSha1: fileSha1(override),
    uploadTimestamp: FIXTURE_UPLOAD_TS,
    contentType: override.contentType ?? 'application/octet-stream',
    fileInfo: {},
  }
}

function bucketResult(
  bucketName: string,
  bucketId: string,
  bucketType: 'allPrivate' | 'allPublic',
): BucketCommandResult {
  return {
    bucketId,
    bucketName,
    bucketType,
    bucketInfo: {},
    revision: 1,
  }
}
