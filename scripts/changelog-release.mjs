#!/usr/bin/env node
// `version` lifecycle step of `pnpm version` (see RELEASE.md): batch the unreleased changie
// fragments into .changes/v<version>.md, then regenerate CHANGELOG.md from .changes/.
// Prereleases leave the fragments in place so they ship with the next stable release.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const changie = createRequire(import.meta.url).resolve('changie/npm/changie.js')
const run = (...args) =>
  execFileSync(process.execPath, [changie, ...args], { cwd: repo, stdio: 'inherit' })

const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

if (version.includes('-')) {
  console.log(`changelog-release: ${version} is a prerelease; leaving unreleased fragments intact.`)
} else if (existsSync(join(repo, '.changes', `v${version}.md`))) {
  console.log(`changelog-release: .changes/v${version}.md already exists; nothing to batch.`)
} else {
  // The `v` prefix names the file v<version>.md and makes the compare link match the git tag.
  run('batch', `v${version}`)
}
run('merge')
