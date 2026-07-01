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

  it('parses and canonicalizes fileInfo as csv when no newline is present', () => {
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'Build_SHA=abc123,release.version=1.2.3,ci+owner=release')

    expect(parseInputs().fileInfo).toEqual({
      build_sha: 'abc123',
      'release.version': '1.2.3',
      'ci+owner': 'release',
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

    expect(() => parseInputs()).toThrow(/Reserved fileInfo key "b2-content-type"/)

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
    setInput('file-info', 'Owner=a\nowner=b')

    expect(() => parseInputs()).toThrow(/Duplicate fileInfo key "owner"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', 'src_last_modified_millis=1')
    setInput('preserve-mtime', 'true')

    expect(() => parseInputs()).toThrow(/Duplicate fileInfo key "src_last_modified_millis"/)

    resetInputEnv()
    setInput('action', 'upload')
    setInput('application-key-id', 'k')
    setInput('application-key', 's')
    setInput('bucket', 'b')
    setInput('file-info', `build=${'x'.repeat(2048)}`)

    expect(() => parseInputs()).toThrow(
      /Invalid fileInfo value for "build": 2048 bytes exceeds 2043/,
    )
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

    const r = parseInputs()
    expect(r.concurrency).toBe(8)
    expect(r.partSize).toBe(5_000_000)
    expect(r.resume).toBe(false)
    expect(r.dryRun).toBe(true)
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
})
