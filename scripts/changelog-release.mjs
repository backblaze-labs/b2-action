#!/usr/bin/env node
// `version` lifecycle step of `pnpm version` (see RELEASE.md): batch the unreleased changie
// fragments into .changes/v<version>.md, then regenerate CHANGELOG.md from .changes/.
// Prereleases change nothing: `changie merge` applies the package.json version replacement from
// the newest version file, so running it for a prerelease would roll the version back.
// Optional argv[2] points at another checkout (used by the tests).

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const changie = createRequire(import.meta.url).resolve('changie/npm/changie.js')
const run = (...args) =>
  execFileSync(process.execPath, [changie, ...args], { cwd: repo, stdio: 'inherit' })

const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

if (version.includes('-')) {
  console.log(`changelog-release: ${version} is a prerelease; leaving the changelog untouched.`)
  process.exit(0)
}
if (existsSync(join(repo, '.changes', `v${version}.md`))) {
  console.log(`changelog-release: .changes/v${version}.md already exists; nothing to batch.`)
} else {
  // The `v` prefix names the file v<version>.md and makes the compare link match the git tag.
  run('batch', `v${version}`)
}
run('merge')
