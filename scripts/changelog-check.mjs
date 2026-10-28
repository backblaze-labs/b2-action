#!/usr/bin/env node
// PR gate: a change to what ships (src/, action.yml, dist/, dependencies) must add a changie
// fragment. Compares HEAD against BASE_REF (default origin/main). Label a PR `skip-changelog`
// to skip the CI job when a shipped-path change has nothing user-visible to say.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { missingEntry } from './changelog-check-lib.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')

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

const changed = git('diff', '--name-only', `${base}...HEAD`)
const added = git('diff', '--name-only', '--diff-filter=A', `${base}...HEAD`)
if (missingEntry(changed, added)) {
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
