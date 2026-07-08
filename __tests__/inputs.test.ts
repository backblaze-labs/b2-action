import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectInputSecretsForScrubbing, parseInputs } from '../src/inputs.ts'
import { captureStdout, resetInputEnv, setInput } from './_helpers.ts'

describe('parseInputs', () => {
  beforeEach(() => {
    resetInputEnv()
    Reflect.deleteProperty(process.env, 'B2_APPLICATION_KEY_ID')
    Reflect.deleteProperty(process.env, 'B2_APPLICATION_KEY')
  })

  afterEach(resetInputEnv)

  it('reads credentials from action inputs', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'kid-1')
    setInput('application-key', 'sek-1')
    setInput('bucket', 'my-bucket')

    const r = parseInputs()
    expect(r.applicationKeyId).toBe('kid-1')
    expect(r.applicationKey).toBe('sek-1')
    expect(r.bucket).toBe('my-bucket')
    expect(r.action).toBe('upload')
  })

  it('falls back to B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY env vars', () => {
    setInput('action', 'download')
    setInput('bucket', 'b')
    process.env.B2_APPLICATION_KEY_ID = 'env-kid'
    process.env.B2_APPLICATION_KEY = 'env-sek'

    const r = parseInputs()
    expect(r.applicationKeyId).toBe('env-kid')
    expect(r.applicationKey).toBe('env-sek')
  })

  it('dedupes parser-scope secret masks before registering them', async () => {
    setInput('application-key', 'secret')
    process.env.B2_APPLICATION_KEY_ID = ' kid '
    process.env.B2_APPLICATION_KEY = 'secret'

    let secrets: string[] = []
    const stdout = await captureStdout(() => {
      secrets = collectInputSecretsForScrubbing()
    })

    expect(secrets).toEqual([' kid ', 'kid', 'secret'])
    expect(stdout.match(/::add-mask::/g)).toHaveLength(3)
  })

  it('rejects an unknown action value', () => {
    setInput('action', 'whatever')
    setInput('bucket', 'b')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    expect(() => parseInputs()).toThrow(/Invalid 'action' input/)
  })

  it('throws when credentials are missing entirely', () => {
    setInput('action', 'upload')
    setInput('bucket', 'b')
    expect(() => parseInputs()).toThrow(/Missing credential/)
  })

  it('parses include/exclude as csv', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('include', 'src/**, dist/**')
    setInput('exclude', '**/*.log')

    const r = parseInputs()
    expect(r.include).toEqual(['src/**', 'dist/**'])
    expect(r.exclude).toEqual(['**/*.log'])
  })

  it('parses upload fileInfo and content header inputs', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput(
      'file-info',
      ['build_sha=abc123', 'source_ref=refs/heads/main', 'owner=ci,release'].join('\n'),
    )
    setInput('cache-control', 'public, max-age=31536000')
    setInput('content-disposition', 'attachment; filename="app.tar.gz"')
    setInput('content-language', 'en-US')
    setInput('expires', 'Wed, 21 Oct 2030 07:28:00 GMT')
    setInput('preserve-mtime', 'yes')

    const r = parseInputs()
    expect(r.fileInfo).toEqual({
      build_sha: 'abc123',
      source_ref: 'refs/heads/main',
      owner: 'ci,release',
      'b2-cache-control': 'public, max-age=31536000',
      'b2-content-disposition': 'attachment; filename="app.tar.gz"',
      'b2-content-language': 'en-US',
      'b2-expires': 'Wed, 21 Oct 2030 07:28:00 GMT',
    })
    expect(r.preserveMtime).toBe(true)
  })

  it('parses and canonicalizes fileInfo as comma-separated pairs when no newline is present', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', "Build_SHA=abc123,release.version=1.2.3,ci+owner=release,ci!role=o'clock")

    expect(parseInputs().fileInfo).toEqual({
      build_sha: 'abc123',
      'release.version': '1.2.3',
      'ci+owner': 'release',
      'ci!role': "o'clock",
    })
  })

  it('rejects invalid, reserved, or duplicate fileInfo keys', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'bad key=value')

    expect(() => parseInputs()).toThrow(/Invalid fileInfo key "bad key"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'b2-content-type=text/html')

    expect(() => parseInputs()).toThrow(
      /Reserved fileInfo key "b2-content-type".*dedicated upload inputs.*content-type/,
    )

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'B2-Content-Type=text/html')

    expect(() => parseInputs()).toThrow(/Reserved fileInfo key "B2-Content-Type"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'B2-CONTENT-DISPOSITION=inline')
    setInput('content-disposition', 'attachment; filename="app.tar.gz"')

    expect(() => parseInputs()).toThrow(/Reserved fileInfo key "B2-CONTENT-DISPOSITION"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'Owner=a\nowner=b')

    expect(() => parseInputs()).toThrow(/Duplicate fileInfo key "owner"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'SRC_LAST_MODIFIED_MILLIS=1')
    setInput('preserve-mtime', 'true')

    expect(() => parseInputs()).toThrow(/Duplicate fileInfo key "src_last_modified_millis"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', `build=${'x'.repeat(2048)}`)
    setInput('sse', 'B2')

    expect(() => parseInputs()).toThrow(
      /Invalid fileInfo value for "build": 2048 bytes exceeds 2043/,
    )

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', `${'k'.repeat(51)}=v`)

    expect(() => parseInputs()).toThrow(/Invalid fileInfo key "k{51}": 51 bytes exceeds 50/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', Array.from({ length: 11 }, (_, i) => `k${i}=v`).join('\n'))

    expect(() => parseInputs()).toThrow(/Invalid fileInfo: 11 entries exceeds 10/)
  })

  it('parses booleans and integers', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('concurrency', '8')
    setInput('part-size', '5000000')
    setInput('resume', 'false')
    setInput('dry-run', '1')
    setInput('cleanup-unfinished-force', 'yes')
    setInput('cleanup-unfinished-idle-minutes', '60')

    const r = parseInputs()
    expect(r.concurrency).toBe(8)
    expect(r.partSize).toBe(5_000_000)
    expect(r.resume).toBe(false)
    expect(r.dryRun).toBe(true)
    expect(r.cleanupUnfinishedForce).toBe(true)
    expect(r.cleanupUnfinishedIdleMinutes).toBe(60)
  })

  it.each([
    '1e3',
    String(Number.MAX_SAFE_INTEGER + 1),
  ])('rejects unsafe non-negative integers for cleanup idle minutes: %s', (value) => {
    setInput('action', 'cleanup-unfinished')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('cleanup-unfinished-idle-minutes', value)

    expect(() => parseInputs()).toThrow(/non-negative integer/)
  })

  it('keeps an empty purge source only when whole-bucket purge is confirmed', () => {
    setInput('action', 'purge')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('source', '')

    const unconfirmed = parseInputs()
    expect(unconfirmed.source).toBeUndefined()
    expect(unconfirmed.allowBucketPurge).toBe(false)

    resetInputEnv()
    setInput('action', 'purge')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('source', '')
    setInput('allow-bucket-purge', 'true')

    const confirmed = parseInputs()
    expect(confirmed.source).toBe('')
    expect(confirmed.allowBucketPurge).toBe(true)
  })

  it('keeps an empty cleanup-unfinished source only when whole-bucket cleanup is confirmed', () => {
    setInput('action', 'cleanup-unfinished')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('source', '')

    const unconfirmed = parseInputs()
    expect(unconfirmed.source).toBeUndefined()
    expect(unconfirmed.allowBucketCleanup).toBe(false)

    resetInputEnv()
    setInput('action', 'cleanup-unfinished')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('source', '')
    setInput('allow-bucket-cleanup', 'true')

    const confirmed = parseInputs()
    expect(confirmed.source).toBe('')
    expect(confirmed.allowBucketCleanup).toBe(true)
  })
})
