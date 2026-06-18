#!/usr/bin/env node
/**
 * Verify that every input and output declared in `action.yml` appears in
 * `README.md`'s "Inputs (full reference)" and "Outputs (full reference)"
 * tables, and that every output declared in `action.yml` is emitted by the
 * action implementation via `core.setOutput(...)`.
 *
 * Catches common drift modes:
 *
 *   - added a new input, forgot to document it
 *   - added a new output, forgot to document it
 *   - documented an output, forgot to emit it
 *   - emitted an output, forgot to declare it
 *
 * The action.yml parser is regex-based (no external YAML dep) because
 * the file's shape is well-known and stable:
 *
 *   inputs:
 *     <name>:
 *       description: ...
 *   outputs:
 *     <name>:
 *       description: ...
 *
 * Run with:  pnpm docs:check-action-yml
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

const actionYml = readFileSync(join(REPO, 'action.yml'), 'utf8')
const readme = readFileSync(join(REPO, 'README.md'), 'utf8')

function escapeRegExpLiteral(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Extract top-level keys from a section of action.yml. Looks for the
 * `^section:` header, then every `^  <name>:` line until the next
 * top-level key.
 */
function extractActionYmlKeys(section) {
  const start = actionYml.search(new RegExp(`^${escapeRegExpLiteral(section)}:\\s*$`, 'm'))
  if (start === -1) return []
  const rest = actionYml.slice(start + section.length + 1)
  const end = rest.search(/^[a-z]+:\s*$/m)
  const body = end === -1 ? rest : rest.slice(0, end)
  const keys = []
  for (const line of body.split('\n')) {
    const m = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/)
    if (m) keys.push(m[1])
  }
  return keys
}

const declaredInputs = extractActionYmlKeys('inputs')
const declaredOutputs = extractActionYmlKeys('outputs')

/**
 * Extract the set of `key` names appearing in the first column of a
 * markdown table that sits under the given heading.
 */
function extractKeysFromSection(heading) {
  const re = new RegExp(`^##\\s+${escapeRegExpLiteral(heading)}.*$`, 'm')
  const start = readme.search(re)
  if (start === -1) {
    throw new Error(`Heading not found in README.md: ${heading}`)
  }
  const rest = readme.slice(start + 1)
  const end = rest.search(/^##\s+/m)
  const section = end === -1 ? rest : rest.slice(0, end)
  const keys = new Set()
  for (const line of section.split('\n')) {
    if (!line.startsWith('|') || line.startsWith('|---')) continue
    const first = line.split('|')[1] ?? ''
    const match = first.match(/`([^`]+)`/)
    if (match) keys.add(match[1])
  }
  return keys
}

const readmeInputs = extractKeysFromSection('Inputs (full reference)')
const readmeOutputs = extractKeysFromSection('Outputs (full reference)')
const implementationOutputs = extractSetOutputKeys(join(REPO, 'src'))

const missingFromReadmeInputs = declaredInputs.filter((k) => !readmeInputs.has(k))
const missingFromReadmeOutputs = declaredOutputs.filter((k) => !readmeOutputs.has(k))
const orphanedInReadmeInputs = [...readmeInputs].filter((k) => !declaredInputs.includes(k))
const orphanedInReadmeOutputs = [...readmeOutputs].filter((k) => !declaredOutputs.includes(k))
const missingFromImplementationOutputs = declaredOutputs.filter(
  (k) => !implementationOutputs.has(k),
)
const undeclaredImplementationOutputs = [...implementationOutputs]
  .filter((k) => !declaredOutputs.includes(k))
  .sort()

function* walkTsFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkTsFiles(path)
    } else if (entry.isFile() && path.endsWith('.ts')) {
      yield path
    }
  }
}

function extractSetOutputKeys(dir) {
  const keys = new Set()
  for (const file of walkTsFiles(dir)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/core\.setOutput\(\s*['"]([a-z][a-z0-9-]*)['"]/g)) {
      keys.add(match[1])
    }
  }
  return keys
}

let failed = false
function report(label, missing, orphaned) {
  if (missing.length > 0) {
    failed = true
    console.error(`✗ ${label}: in action.yml but missing from README:`)
    for (const k of missing) console.error(`    - ${k}`)
  }
  if (orphaned.length > 0) {
    failed = true
    console.error(`✗ ${label}: in README but not declared in action.yml:`)
    for (const k of orphaned) console.error(`    - ${k}`)
  }
}

report('Inputs', missingFromReadmeInputs, orphanedInReadmeInputs)
report('Outputs', missingFromReadmeOutputs, orphanedInReadmeOutputs)

if (missingFromImplementationOutputs.length > 0) {
  failed = true
  console.error('✗ Outputs: in action.yml but not emitted by src/:')
  for (const k of missingFromImplementationOutputs) console.error(`    - ${k}`)
}
if (undeclaredImplementationOutputs.length > 0) {
  failed = true
  console.error('✗ Outputs: emitted by src/ but not declared in action.yml:')
  for (const k of undeclaredImplementationOutputs) console.error(`    - ${k}`)
}

if (failed) {
  console.error('')
  console.error('action.yml is the source of truth for docs, and src/ is the output contract.')
  console.error('Update the mismatched surface, then re-run `pnpm docs:check-action-yml`.')
  process.exit(1)
}

console.log(
  `✓ ${declaredInputs.length} inputs and ${declaredOutputs.length} outputs aligned across action.yml, README.md, and src/.`,
)
