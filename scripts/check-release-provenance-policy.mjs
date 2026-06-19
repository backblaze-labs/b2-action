#!/usr/bin/env node
/**
 * Enforce the release provenance isolation contract introduced for issue #19.
 *
 * The important invariant is structural: only the `attest` job in release.yml
 * may mint OIDC or artifact-attestation tokens, while `publish` runs without
 * those scopes and only after the validated tag/commit has been attested. The
 * checker parses workflow YAML instead of matching raw text so equivalent YAML
 * spelling, quoting, key order, comments, and anchors cannot bypass the guard.
 *
 * Scope: release.yml gets the full release-policy audit. Other workflow files
 * are checked only for unexpected `attestations: write`; non-attestation OIDC
 * uses such as GitHub Pages remain covered by the shared workflow-security job.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowDir = resolve(repoRoot, '.github/workflows')
const releaseWorkflowPath = join(workflowDir, 'release.yml')
const fixtureDir = resolve(repoRoot, 'scripts/fixtures/release-provenance-policy')

const failures = []

function fail(message) {
  failures.push(message)
}

function asMapping(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asArray(value) {
  if (Array.isArray(value)) return value
  if (value === undefined || value === null) return []
  return [value]
}

function loadWorkflow(filePath) {
  const source = readFileSync(filePath, 'utf8')
  try {
    return {
      doc: asMapping(parse(source, { prettyErrors: false })),
      source,
    }
  } catch (error) {
    fail(`${filePath} must be valid YAML: ${error.message}`)
    return { doc: {}, source }
  }
}

function workflowFiles() {
  return readdirSync(workflowDir)
    .filter((file) => /\.(ya?ml)$/.test(file))
    .map((file) => join(workflowDir, file))
}

function permissionIsWrite(permissions, name) {
  const shorthand = typeof permissions === 'string' ? permissions.trim().toLowerCase() : ''
  if (shorthand === 'write-all') return true

  const value = asMapping(permissions)[name]
  return typeof value === 'string' && value.trim().toLowerCase() === 'write'
}

function canMintAttestation(permissions) {
  return (
    permissionIsWrite(permissions, 'id-token') || permissionIsWrite(permissions, 'attestations')
  )
}

function compactExpression(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
}

function githubExpression(expression) {
  return `\${{ ${expression} }}`
}

function resolvesToValidateOutput(job, value, outputName) {
  const expected = githubExpression(`needs.validate.outputs.${outputName}`)
  const expression = compactExpression(value)
  if (expression === expected) return true

  const envMatch = expression.match(/^\${{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*}}$/)
  if (!envMatch) return false

  const envValue = asMapping(job.env)[envMatch[1]]
  return compactExpression(envValue) === expected
}

function jobNames(doc) {
  return Object.keys(asMapping(doc.jobs))
}

function job(doc, name) {
  return asMapping(asMapping(doc.jobs)[name])
}

function needs(jobConfig) {
  return new Set(asArray(jobConfig.needs).map(String))
}

function steps(jobConfig) {
  return asArray(jobConfig.steps).map(asMapping)
}

function stepUses(step, actionPrefix) {
  return typeof step.uses === 'string' && step.uses.startsWith(actionPrefix)
}

function stepRun(step) {
  return typeof step.run === 'string' ? step.run : ''
}

function findStep(jobConfig, predicate) {
  return steps(jobConfig).find(predicate)
}

function findRunStepContaining(jobConfig, terms) {
  return findStep(jobConfig, (step) => {
    const run = stepRun(step)
    return terms.every((term) => run.includes(term))
  })
}

function requireCondition(condition, message) {
  if (!condition) fail(message)
}

function requireJob(doc, name) {
  const config = job(doc, name)
  requireCondition(Object.keys(config).length > 0, `release workflow must define a ${name} job`)
  return config
}

function requireStep(jobName, description, step) {
  requireCondition(Boolean(step), `${jobName} must ${description}`)
}

function requireTimeout(jobName, jobConfig, minutes) {
  const timeout = Number(jobConfig['timeout-minutes'])
  requireCondition(
    Number.isFinite(timeout) && timeout > 0 && timeout <= minutes,
    `${jobName} must set timeout-minutes to ${minutes} or less`,
  )
}

function checkPermissionIsolation(doc, label, report = fail) {
  const workflowPermissions = doc.permissions

  for (const permission of ['id-token', 'attestations']) {
    if (permissionIsWrite(workflowPermissions, permission)) {
      report(`${label} must not request workflow-level ${permission}: write`)
    }
  }

  for (const [name, config] of Object.entries(asMapping(doc.jobs))) {
    const permissions = asMapping(config).permissions
    if (canMintAttestation(permissions) && name !== 'attest') {
      report(
        `${label}: only the attest job may request id-token: write or attestations: write (${name})`,
      )
    }
    if (canMintAttestation(permissions) && permissionIsWrite(permissions, 'contents')) {
      report(`${label}: ${name} must not combine OIDC/attestation permissions with contents: write`)
    }
  }
}

function checkGlobalAttestationPermissions() {
  for (const filePath of workflowFiles()) {
    const { doc } = loadWorkflow(filePath)
    const label = basename(filePath)
    if (label === 'release.yml') continue

    if (permissionIsWrite(doc.permissions, 'attestations')) {
      fail(`${label} must not request workflow-level attestations: write`)
    }

    for (const [name, config] of Object.entries(asMapping(doc.jobs))) {
      if (permissionIsWrite(asMapping(config).permissions, 'attestations')) {
        fail(`${label}:${name} must not request attestations: write`)
      }
    }
  }
}

function checkReleaseWorkflow(doc) {
  checkPermissionIsolation(doc, 'release.yml')

  const names = jobNames(doc)
  for (const required of ['validate', 'attest', 'publish']) {
    requireCondition(names.includes(required), `release workflow must define a ${required} job`)
  }

  const validate = requireJob(doc, 'validate')
  const attest = requireJob(doc, 'attest')
  const publish = requireJob(doc, 'publish')

  requireTimeout('validate', validate, 25)
  requireTimeout('attest', attest, 10)
  requireTimeout('publish', publish, 20)

  const validateOutputs = asMapping(validate.outputs)
  requireCondition(
    compactExpression(validateOutputs['release-sha']) ===
      githubExpression('steps.release-ref.outputs.release-sha'),
    'validate must export the resolved release-sha output',
  )
  requireCondition(
    compactExpression(validateOutputs['release-tag']) ===
      githubExpression('steps.release-ref.outputs.release-tag'),
    'validate must export the resolved release-tag output',
  )

  const releaseRefStep = findStep(
    validate,
    (step) =>
      step.id === 'release-ref' && asMapping(step.env).RUN_REF === githubExpression('github.ref'),
  )
  requireStep('validate', 'resolve the requested release tag against github.ref', releaseRefStep)
  if (releaseRefStep) {
    // The tag authorization and checkout happen in shell, so this is a
    // command-shape check for the race-prevention invariant, not a formatter
    // assertion about the whole script body.
    requireCondition(
      stepRun(releaseRefStep).includes('refs/tags/$REQUESTED_REF') &&
        stepRun(releaseRefStep).includes('git checkout --detach'),
      'validate must reject non-tag dispatch refs and checkout the resolved commit SHA',
    )
  }

  const setupNodeStep = findStep(validate, (step) => stepUses(step, 'actions/setup-node@'))
  requireStep('validate', 'configure actions/setup-node', setupNodeStep)
  if (setupNodeStep) {
    // setup-node's implicit package-manager cache is disabled here because the
    // release job handles runtime artifacts. Re-enabling it changes the release
    // trust boundary, so it belongs in this security policy.
    requireCondition(
      asMapping(setupNodeStep.with)['package-manager-cache'] === false,
      'validate setup-node must disable implicit package-manager caching',
    )
  }

  requireCondition(needs(attest).has('validate'), 'attest must depend on validate')
  requireCondition(
    permissionIsWrite(attest.permissions, 'id-token'),
    'attest must request id-token: write',
  )
  requireCondition(
    permissionIsWrite(attest.permissions, 'attestations'),
    'attest must request attestations: write',
  )
  requireCondition(
    asMapping(attest.permissions).contents === 'read',
    'attest permissions must keep contents read-only',
  )
  requireCheckoutByValidatedSha('attest', attest)
  requireTagReverification('attest', attest)
  requireStep(
    'attest',
    'call actions/attest-build-provenance for dist/index.js',
    findStep(
      attest,
      (step) =>
        stepUses(step, 'actions/attest-build-provenance@') &&
        asMapping(step.with)['subject-path'] === 'dist/index.js',
    ),
  )
  requireStep(
    'attest',
    'emit an explanatory annotation if provenance signing fails',
    findRunStepContaining(attest, ['Provenance attestation failed', 'Sigstore']),
  )

  const publishNeeds = needs(publish)
  requireCondition(
    publishNeeds.has('validate') && publishNeeds.has('attest'),
    'publish must depend on validate and attest',
  )
  requireCondition(
    asMapping(publish.permissions).contents === 'write',
    'publish must request contents: write',
  )
  requireCondition(
    !canMintAttestation(asMapping(publish.permissions)),
    'publish must not request OIDC or attestation permissions',
  )
  requireCheckoutByValidatedSha('publish', publish)
  requireTagReverification('publish', publish)
  requireStep(
    'publish',
    'verify release assets before upload',
    findRunStepContaining(publish, ['-s "$file"']),
  )
  requireCondition(
    !steps(publish).some((step) => stepUses(step, 'softprops/action-gh-release@')),
    'publish must not delegate release asset upload to softprops/action-gh-release',
  )
  requireStep(
    'publish',
    'stage assets on a draft release before publishing it',
    findRunStepContaining(publish, ['gh release create', '--draft', 'gh release upload']),
  )
  const verifyAssetsStep = findRunStepContaining(publish, [
    'gh release download',
    'sha256sum',
    'gh attestation verify',
  ])
  requireStep('publish', 'download and verify published release assets', verifyAssetsStep)
  requireStep(
    'publish',
    'publish the draft release only after downloaded assets verify',
    findRunStepContaining(publish, ['gh release edit', '--draft=false']),
  )
  requireStep(
    'publish',
    'fail stable releases when FLOATING_TAG_TOKEN is missing',
    findRunStepContaining(publish, ['::error::FLOATING_TAG_TOKEN', 'exit 1']),
  )
}

function requireCheckoutByValidatedSha(jobName, jobConfig) {
  const checkout = findStep(jobConfig, (step) => stepUses(step, 'actions/checkout@'))
  requireStep(jobName, 'checkout the repository', checkout)
  if (!checkout) return

  requireCondition(
    resolvesToValidateOutput(jobConfig, asMapping(checkout.with).ref, 'release-sha'),
    `${jobName} checkout must use needs.validate.outputs.release-sha`,
  )
}

function requireTagReverification(jobName, jobConfig) {
  requireStep(
    jobName,
    're-verify the release tag still points to the validated SHA',
    findRunStepContaining(jobConfig, [
      'git fetch',
      'refs/tags/$RELEASE_TAG',
      'git rev-parse',
      '$RELEASE_SHA',
    ]),
  )
}

function checkPermissionFixtures() {
  if (!existsSync(fixtureDir)) return

  for (const file of readdirSync(fixtureDir).filter((name) => name.startsWith('invalid-'))) {
    const filePath = join(fixtureDir, file)
    const { doc, source } = loadWorkflow(filePath)
    const expected = /^# expected: (.+)$/m.exec(source)?.[1]
    const fixtureFailures = []

    checkPermissionIsolation(doc, file, (message) => fixtureFailures.push(message))

    if (fixtureFailures.length === 0) {
      fail(`fixture ${file} must fail the permission-isolation policy`)
    } else if (expected && !fixtureFailures.some((message) => message.includes(expected))) {
      fail(`fixture ${file} must fail with a message containing: ${expected}`)
    }
  }
}

checkGlobalAttestationPermissions()
checkReleaseWorkflow(loadWorkflow(releaseWorkflowPath).doc)
checkPermissionFixtures()

if (failures.length > 0) {
  console.error('Release provenance policy failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Release provenance policy OK')
