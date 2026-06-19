import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflow = readFileSync(resolve(repoRoot, '.github/workflows/release.yml'), 'utf8')
const jobsMatch = /(^|\r?\n)jobs:\r?\n/.exec(workflow)
const jobsText = jobsMatch ? workflow.slice(jobsMatch.index + jobsMatch[1].length) : ''

const failures = []

function fail(message) {
  failures.push(message)
}

function jobNames() {
  return [...jobsText.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1])
}

function jobBlock(name) {
  const lines = jobsText.split(/\r?\n/)
  const start = lines.indexOf(`  ${name}:`)
  if (start === -1) return ''
  const end = lines.findIndex((line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:$/.test(line))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}

function requireIn(blockName, block, text) {
  if (!block.includes(text)) fail(`${blockName} must contain: ${text}`)
}

function rejectIn(blockName, block, pattern, message) {
  if (pattern.test(block)) fail(`${blockName} must not ${message}`)
}

const names = jobNames()
const validate = jobBlock('validate')
const attest = jobBlock('attest')
const publish = jobBlock('publish')

for (const required of ['validate', 'attest', 'publish']) {
  if (!names.includes(required)) fail(`release workflow must define a ${required} job`)
}

for (const name of names) {
  const block = jobBlock(name)
  const canMintOidc = /(?:id-token|attestations): write/.test(block)
  if (canMintOidc && name !== 'attest') {
    fail(`only the attest job may request id-token: write or attestations: write (${name})`)
  }
  if (canMintOidc && /FLOATING_TAG_TOKEN|softprops\/action-gh-release/.test(block)) {
    fail(`${name} must not combine OIDC/attestation permissions with release publishing or PAT use`)
  }
}

requireIn('validate', validate, `release-sha: \${{ steps.release-ref.outputs.release-sha }}`)
requireIn('validate', validate, `release-tag: \${{ steps.release-ref.outputs.release-tag }}`)
requireIn('validate', validate, 'git show-ref --verify --quiet "refs/tags/$REQUESTED_REF"')
requireIn('validate', validate, `RUN_REF: \${{ github.ref }}`)
requireIn('validate', validate, 'git checkout --detach "$RELEASE_SHA"')

requireIn('attest', attest, 'needs: validate')
requireIn('attest', attest, 'contents: read')
requireIn('attest', attest, 'id-token: write')
requireIn('attest', attest, 'attestations: write')
requireIn('attest', attest, `ref: \${{ env.RELEASE_SHA }}`)
requireIn('attest', attest, 'Verify release tag still points to validated commit')
requireIn(
  'attest',
  attest,
  'git fetch --force --no-tags origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
)
requireIn('attest', attest, 'uses: actions/attest-build-provenance@')
rejectIn('attest', attest, /FLOATING_TAG_TOKEN/, 'reference FLOATING_TAG_TOKEN')
rejectIn('attest', attest, /softprops\/action-gh-release/, 'run the release publishing action')

requireIn('publish', publish, 'needs: [validate, attest]')
requireIn('publish', publish, 'contents: write')
requireIn('publish', publish, `ref: \${{ env.RELEASE_SHA }}`)
requireIn('publish', publish, 'Verify release tag still points to validated commit')
requireIn(
  'publish',
  publish,
  'git fetch --force --no-tags origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"',
)
requireIn('publish', publish, 'Verify release assets exist')
requireIn('publish', publish, `GH_TOKEN: \${{ secrets.FLOATING_TAG_TOKEN }}`)
requireIn('publish', publish, 'SHA="$RELEASE_SHA"')
rejectIn(
  'publish',
  publish,
  /(?:id-token|attestations): write/,
  'request OIDC/attestation permissions',
)
rejectIn('publish', publish, /uses: actions\/attest-build-provenance@/, 'run attestation')
rejectIn(
  'publish',
  publish,
  /git rev-parse "\$\{RELEASE_TAG\}\^\{commit\}"/,
  're-resolve the release tag after validation',
)

if (failures.length > 0) {
  console.error('Release provenance policy failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Release provenance policy OK')
