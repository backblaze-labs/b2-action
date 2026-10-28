import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repo, 'scripts/changelog-release.mjs')

let root: string

async function setVersion(version: string): Promise<void> {
  // Two-space JSON so the .changie.yaml package.json replacement really applies.
  await writeFile(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'b2', version }, null, 2)}\n`,
  )
}

const release = () => execFileSync(process.execPath, [script, root], { stdio: 'pipe' })
const version = async () =>
  (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string }).version
const fragments = async () =>
  (await readdir(join(root, '.changes/unreleased'))).filter((f) => f.endsWith('.yaml'))

describe('changelog-release', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'b2-changelog-release-'))
    await cp(join(repo, '.changie.yaml'), join(root, '.changie.yaml'))
    await cp(join(repo, '.changes'), join(root, '.changes'), { recursive: true })
    await cp(join(repo, 'CHANGELOG.md'), join(root, 'CHANGELOG.md'))
    await writeFile(
      join(root, '.changes/unreleased/Fixed-20990101-000000.yaml'),
      'kind: Fixed\nbody: A test fragment.\ntime: 2099-01-01T00:00:00Z\n',
    )
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('leaves the version, fragments, and changelog untouched for a prerelease', async () => {
    await setVersion('9.0.0-rc.0')
    const changelogBefore = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    const fragmentsBefore = await fragments()

    release()

    expect(await version()).toBe('9.0.0-rc.0')
    expect(await fragments()).toEqual(fragmentsBefore)
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(changelogBefore)
  })

  it('batches fragments into a version file and keeps the stable version', async () => {
    await setVersion('9.0.0')

    release()

    expect(await version()).toBe('9.0.0')
    expect(await fragments()).toEqual([])
    const notes = await readFile(join(root, '.changes/v9.0.0.md'), 'utf8')
    expect(notes).toMatch(/^## \[9\.0\.0\] - \d{4}-\d{2}-\d{2}/)
    expect(notes).toContain('- A test fragment.')
    const changelog = await readFile(join(root, 'CHANGELOG.md'), 'utf8')
    expect(changelog.indexOf('## [9.0.0]')).toBeGreaterThan(changelog.indexOf('## [Unreleased]'))
    expect(changelog.indexOf('## [9.0.0]')).toBeLessThan(changelog.indexOf('## [1.2.0]'))
  })

  it('is a no-op batch when the version file already exists', async () => {
    await setVersion('9.0.0')
    release()
    const notes = await readFile(join(root, '.changes/v9.0.0.md'), 'utf8')

    release()

    expect(await readFile(join(root, '.changes/v9.0.0.md'), 'utf8')).toBe(notes)
    expect(await version()).toBe('9.0.0')
  })
})
