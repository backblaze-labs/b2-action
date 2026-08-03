import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadCommand } from '../src/commands/download.ts'
import { syncCommand, warnOnImplicitDownload } from '../src/commands/sync.ts'
import { relativeUploadKey, uploadCommand } from '../src/commands/upload.ts'
import { verifyCommand } from '../src/commands/verify.ts'
import { expandTilde } from '../src/fs.ts'
import { captureStdout, makeFixture, makeInputs, seedFile, type TestFixture } from './_helpers.ts'

/**
 * Point `os.homedir()` at a scratch directory so the tilde tests never touch
 * the real home directory of a contributor or a CI runner. `homedir()` reads
 * `HOME` on POSIX and `USERPROFILE` on Windows.
 */
function useFakeHome(dir: string): void {
  process.env.HOME = dir
  process.env.USERPROFILE = dir
}

describe('expandTilde', () => {
  let fakeHome: string
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), 'b2-home-'))
    useFakeHome(fakeHome)
  })
  afterEach(async () => {
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('expands a bare tilde and a leading tilde segment', () => {
    expect(expandTilde('~')).toBe(homedir())
    expect(expandTilde('~/.cache/huggingface')).toBe(join(homedir(), '.cache', 'huggingface'))
  })

  it('leaves undefined, relative, and absolute paths untouched', () => {
    expect(expandTilde(undefined)).toBeUndefined()
    expect(expandTilde('./checkpoints')).toBe('./checkpoints')
    expect(expandTilde('/var/data')).toBe('/var/data')
    expect(expandTilde('caches/Linux/hf/')).toBe('caches/Linux/hf/')
  })

  it('does not expand a mid-path tilde', () => {
    expect(expandTilde('models/~backup/weights.pt')).toBe('models/~backup/weights.pt')
  })

  it('warns and passes through ~user forms', async () => {
    let expanded = ''
    const stdout = await captureStdout(() => {
      expanded = expandTilde('~someone/data')
    })
    expect(expanded).toBe('~someone/data')
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain('~user')
  })
})

describe('tilde-prefixed local paths reach the real home directory', () => {
  let fx: TestFixture
  let cwd: string
  let fakeHome: string
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE

  beforeEach(async () => {
    fx = await makeFixture(`tilde-${process.hrtime.bigint()}`)
    fakeHome = await mkdtemp(join(tmpdir(), 'b2-home-'))
    useFakeHome(fakeHome)
    cwd = process.cwd()
    process.chdir(fx.workDir)
  })
  afterEach(async () => {
    process.chdir(cwd)
    process.env.HOME = originalHome
    process.env.USERPROFILE = originalUserProfile
    await rm(fx.workDir, { recursive: true, force: true })
    await rm(fakeHome, { recursive: true, force: true })
  })

  it('upload: a tilde source uploads the home-directory file under the exact key', async () => {
    const local = join(fakeHome, 'weights.pt')
    await writeFile(local, 'w')
    const r = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: '~/weights.pt', destination: 'models/weights.pt' }),
    )
    expect(r.files.map((f) => f.fileName)).toEqual(['models/weights.pt'])
    expect(r.files[0]?.localPath).toBe(local)
  })

  it('download: a tilde destination writes under the home directory', async () => {
    await seedFile(fx, 'weights.pt', 'w')
    const r = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'weights.pt', destination: '~/.cache/weights.pt' }),
    )
    expect(r.files[0]?.localPath).toBe(join(fakeHome, '.cache', 'weights.pt'))
  })

  it('sync down: a tilde destination writes under the home directory', async () => {
    await seedFile(fx, 'caches/hf/blob', 'x')
    const r = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, {
        source: 'caches/hf/',
        destination: '~/.cache/huggingface',
        syncDirection: 'down',
      }),
    )
    expect(r.downloaded).toBe(1)
    const landed = await stat(join(fakeHome, '.cache', 'huggingface', 'blob'))
    expect(landed.isFile()).toBe(true)
  })

  it('sync up: a tilde source is recognized as a local directory', async () => {
    await mkdir(join(fakeHome, 'hf'), { recursive: true })
    await writeFile(join(fakeHome, 'hf', 'blob'), 'x')
    const r = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, { source: '~/hf', destination: 'caches/hf/', syncDirection: 'up' }),
    )
    expect(r.direction).toBe('local-to-b2')
    expect(r.uploaded).toBe(1)
  })

  it('sync auto: a tilde source resolves to an up sync', async () => {
    await mkdir(join(fakeHome, 'hf'), { recursive: true })
    await writeFile(join(fakeHome, 'hf', 'blob'), 'x')
    const r = await syncCommand(
      fx.bucket,
      makeInputs('sync', fx, { source: '~/hf', destination: 'caches/hf/' }),
    )
    expect(r.direction).toBe('local-to-b2')
  })

  it('verify: a tilde destination hashes the home-directory file', async () => {
    const local = join(fakeHome, 'weights.pt')
    await writeFile(local, 'w')
    await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: local, destination: 'weights.pt' }),
    )
    const r = await verifyCommand(
      fx.bucket,
      makeInputs('verify', fx, { source: 'weights.pt', destination: '~/weights.pt' }),
    )
    expect(r.verified).toBe(true)
  })
})

describe('glob uploads whose matches live outside the working directory', () => {
  let fx: TestFixture
  let cwd: string
  let outside: string

  beforeEach(async () => {
    fx = await makeFixture(`outside-${process.hrtime.bigint()}`)
    outside = await mkdtemp(join(tmpdir(), 'b2-outside-'))
    cwd = process.cwd()
    process.chdir(fx.workDir)
  })
  afterEach(async () => {
    process.chdir(cwd)
    await rm(fx.workDir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })

  it('produces keys without ".." segments, and they round-trip', async () => {
    await mkdir(join(outside, 'nested'), { recursive: true })
    await writeFile(join(outside, 'nested', 'a.bin'), 'a')
    const pattern = `${outside.replaceAll('\\', '/')}/nested/*.bin`

    const up = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: pattern, destination: 'artifacts/' }),
    )
    expect(up.files.map((f) => f.fileName)).toEqual(['artifacts/a.bin'])

    // The regression this guards: keys carrying `..` uploaded fine but the
    // action's own prefix download refused to map them back onto disk.
    const down = await downloadCommand(
      fx.bucket,
      makeInputs('download', fx, { source: 'artifacts/', destination: './restored' }),
    )
    expect(down.files.map((f) => f.fileName)).toEqual(['artifacts/a.bin'])
  })

  it('keeps historical keys for globs inside the working directory', async () => {
    await mkdir('build/js', { recursive: true })
    await writeFile('build/js/app.js', 'x')
    const r = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: 'build/**/*.js', destination: 'site/' }),
    )
    expect(r.files.map((f) => f.fileName)).toEqual(['site/build/js/app.js'])
  })

  it('keeps directory-source keys relative to that directory', async () => {
    await mkdir(join(outside, 'nested'), { recursive: true })
    await writeFile(join(outside, 'nested', 'a.bin'), 'a')
    const r = await uploadCommand(
      fx.bucket,
      makeInputs('upload', fx, { source: outside, destination: 'artifacts/' }),
    )
    expect(r.files.map((f) => f.fileName)).toEqual(['artifacts/nested/a.bin'])
  })
})

describe('relativeUploadKey', () => {
  it('prefers the first root that contains the match', () => {
    const roots = [join(tmpdir(), 'first'), join(tmpdir(), 'first', 'second')]
    expect(relativeUploadKey(roots, join(tmpdir(), 'first', 'second', 'a.bin'))).toBe(
      ['second', 'a.bin'].join('/'),
    )
  })

  it('falls back to the basename when no root contains the match', () => {
    expect(relativeUploadKey([join(tmpdir(), 'nope')], join(tmpdir(), 'elsewhere', 'a.bin'))).toBe(
      'a.bin',
    )
  })

  it('never returns a key with a traversal segment', () => {
    const key = relativeUploadKey([join(tmpdir(), 'a', 'b')], join(tmpdir(), 'a', 'c', 'd.bin'))
    expect(key).not.toContain('..')
  })
})

describe('warnOnImplicitDownload', () => {
  it('warns when auto-detection turns a local-looking source into a download', async () => {
    const stdout = await captureStdout(() => {
      warnOnImplicitDownload('auto', 'b2-to-local', './.cache/huggingface')
    })
    expect(stdout).toContain('::warning::')
    expect(stdout).toContain("'direction: up'")
  })

  it('warns for tilde and absolute sources too', async () => {
    const stdout = await captureStdout(() => {
      warnOnImplicitDownload('auto', 'b2-to-local', '~/.cache/huggingface')
      warnOnImplicitDownload('auto', 'b2-to-local', '/var/data/cache')
    })
    expect(stdout.match(/::warning::/g)).toHaveLength(2)
  })

  it('stays quiet for explicit directions and for B2-looking prefixes', async () => {
    const stdout = await captureStdout(() => {
      warnOnImplicitDownload('down', 'b2-to-local', './.cache/huggingface')
      warnOnImplicitDownload('auto', 'b2-to-local', 'caches/Linux/huggingface/')
      warnOnImplicitDownload('auto', 'local-to-b2', './public')
    })
    expect(stdout).not.toContain('::warning::')
  })
})
