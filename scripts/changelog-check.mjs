#!/usr/bin/env node
// PR gate: a change to what ships (src/, dist/, action.yml, dependencies, workflows) must add a
// valid changelog entry: a changie fragment with a kind and a body, or, on a release PR, the
// batched notes for the package.json version with at least one entry. Compares HEAD against
// BASE_REF (default origin/main). Label a PR `skip-changelog` when nothing user-visible changed.
// CHANGELOG_CHECK_ROOT points at another checkout (used by the tests).

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import {
  isUnreleasedFragment,
  isValidFragment,
  isValidReleaseNotes,
  missingEntry,
} from './changelog-check-lib.mjs'

const repo = resolve(
  process.env.CHANGELOG_CHECK_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..'),
)

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function fail(message) {
  console.error(`changelog-check: ${message}`)
  process.exit(1)
}

const base = process.env.BASE_REF || 'origin/main'
try {
  git('rev-parse', '--verify', '--quiet', base)
} catch {
  fail(`BASE_REF ${base} not found; run 'git fetch origin' or set BASE_REF.`)
}

// --no-renames keeps the old path of a file moved out of a shipped directory.
const changed = git('diff', '--name-only', '--no-renames', `${base}...HEAD`)
const added = git('diff', '--name-only', '--no-renames', '--diff-filter=A', `${base}...HEAD`)
const { version } = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))

let validEntries = 0
for (const file of added.filter(isUnreleasedFragment)) {
  let parsed
  try {
    parsed = parse(readFileSync(join(repo, file), 'utf8'))
  } catch {
    parsed = null
  }
  if (!isValidFragment(parsed)) fail(`${file} needs a non-empty kind and body.`)
  validEntries++
}
// Only the notes for the version being released count. Other version files (history added by a
// migration, or a version that is not being released) neither satisfy nor fail the check.
for (const file of added.filter((f) => f === `.changes/v${version}.md`)) {
  if (!isValidReleaseNotes(file, readFileSync(join(repo, file), 'utf8'), version)) {
    fail(
      `${file} is not valid release notes: it needs at least one entry. Ordinary PRs add a ` +
        'fragment with pnpm changelog:new instead.',
    )
  }
  validEntries++
}

if (missingEntry(changed, validEntries)) {
  fail(
    "this PR changes what ships but adds no changelog entry. Run 'pnpm changelog:new', " +
      'or label the PR skip-changelog if nothing user-visible changed.',
  )
}

const unreleased = join(repo, '.changes', 'unreleased')
if (existsSync(unreleased) && readdirSync(unreleased).some((f) => f.endsWith('.yaml'))) {
  const changie = createRequire(import.meta.url).resolve('changie/npm/changie.js')
  try {
    execFileSync(process.execPath, [changie, 'batch', 'auto', '--dry-run'], {
      cwd: repo,
      stdio: 'pipe',
    })
  } catch (error) {
    fail(`changie cannot batch the unreleased fragments:\n${error.stderr ?? error.message}`)
  }
}
console.log('changelog-check: OK')
