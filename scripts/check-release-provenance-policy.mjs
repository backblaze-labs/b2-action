#!/usr/bin/env node
/**
 * Enforce the release provenance isolation contract introduced for issue #19.
 *
 * The important release.yml invariant is structural: only the `attest` job may
 * mint OIDC or artifact-attestation tokens, while `publish` runs without those
 * write scopes and only after the validated tag/commit has been attested. The
 * checker parses workflow YAML instead of matching raw text so equivalent YAML
 * spelling, quoting, key order, comments, and anchors cannot bypass the guard.
 *
 * Scope: release.yml gets the full release-policy audit. Other workflow files
 * must not request `attestations: write` or `id-token: write`, except the
 * documented GitHub Pages deployment job in docs.yml.
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
  let source = ''
  try {
    source = readFileSync(filePath, 'utf8')
  } catch (error) {
    fail(`${filePath} must be readable: ${error.message}`)
    return { doc: {}, source }
  }

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
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => join(workflowDir, file))
}

function permissionIsWrite(permissions, name) {
  const shorthand = typeof permissions === 'string' ? permissions.trim().toLowerCase() : ''
  if (shorthand === 'write-all') return true

  const value = asMapping(permissions)[name]
  return typeof value === 'string' && value.trim().toLowerCase() === 'write'
}

function permissionIsSpecified(permissions, name) {
  if (typeof permissions === 'string') return permissions.trim() !== ''
  return Object.hasOwn(asMapping(permissions), name)
}

function effectivePermissionIsWrite(workflowPermissions, jobPermissions, name) {
  if (permissionIsSpecified(jobPermissions, name)) return permissionIsWrite(jobPermissions, name)
  return permissionIsWrite(workflowPermissions, name)
}

function canMintAttestation(permissions) {
  return (
    permissionIsWrite(permissions, 'id-token') || permissionIsWrite(permissions, 'attestations')
  )
}

function compactExpression(value) {
  if (typeof value !== 'string') return ''

  const trimmed = value.trim()
  const expressionMatch = trimmed.match(/^\$\{\{\s*(.*?)\s*\}\}$/)
  if (expressionMatch) return githubExpression(expressionMatch[1])

  return trimmed.replace(/\s+/g, ' ')
}

function githubExpression(expression) {
  return `\${{${expression.replace(/\s+/g, '')}}}`
}

function resolvesToValidateOutput(job, value, outputName) {
  const expected = githubExpression(`needs.validate.outputs.${outputName}`)
  const expression = compactExpression(value)
  if (expression === expected) return true

  const envMatch = expression.match(/^\$\{\{\s*env\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/)
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

function findStepById(jobConfig, id) {
  return findStep(jobConfig, (step) => step.id === id)
}

function stepIndex(jobConfig, id) {
  return steps(jobConfig).findIndex((step) => step.id === id)
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

function requireStepId(jobName, jobConfig, id, description) {
  const step = findStepById(jobConfig, id)
  requireStep(jobName, description, step)
  return step
}

function requireStepOrder(jobName, jobConfig, ids) {
  let previous = -1
  for (const id of ids) {
    const current = stepIndex(jobConfig, id)
    requireCondition(current >= 0, `${jobName} must define step id ${id}`)
    requireCondition(current > previous, `${jobName} step ${id} must keep the release order`)
    previous = current
  }
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
    if (
      canMintAttestation(permissions) &&
      effectivePermissionIsWrite(workflowPermissions, permissions, 'contents')
    ) {
      report(`${label}: ${name} must not combine OIDC/attestation permissions with contents: write`)
    }
  }
}

function isAllowedGlobalOidc(label, name, config) {
  const permissions = asMapping(config.permissions)
  return (
    label === 'docs.yml' &&
    name === 'deploy' &&
    permissions.pages === 'write' &&
    asMapping(config.environment).name === 'github-pages'
  )
}

function checkGlobalTokenPermissions() {
  for (const filePath of workflowFiles()) {
    const { doc } = loadWorkflow(filePath)
    const label = basename(filePath)
    if (label === 'release.yml') continue

    for (const permission of ['id-token', 'attestations']) {
      if (permissionIsWrite(doc.permissions, permission)) {
        fail(`${label} must not request workflow-level ${permission}: write`)
      }
    }

    for (const [name, config] of Object.entries(asMapping(doc.jobs))) {
      for (const permission of ['id-token', 'attestations']) {
        if (
          permissionIsWrite(asMapping(config).permissions, permission) &&
          !(permission === 'id-token' && isAllowedGlobalOidc(label, name, asMapping(config)))
        ) {
          fail(`${label}:${name} must not request ${permission}: write`)
        }
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

  const validateOutputs = asMapping(validate.outputs)
  requireCondition(
    compactExpression(validateOutputs.release_sha) ===
      githubExpression('steps.release_ref.outputs.release_sha'),
    'validate must export the resolved release_sha output',
  )
  requireCondition(
    compactExpression(validateOutputs.release_tag) ===
      githubExpression('steps.release_ref.outputs.release_tag'),
    'validate must export the resolved release_tag output',
  )

  const releaseRefStep = findStep(
    validate,
    (step) =>
      step.id === 'release_ref' &&
      compactExpression(asMapping(step.env).RUN_REF) === githubExpression('github.ref'),
  )
  requireStep('validate', 'resolve the requested release tag against github.ref', releaseRefStep)
  if (releaseRefStep) {
    // The tag authorization and checkout happen in shell, so this is a
    // command-shape check for the race-prevention invariant, not a formatter
    // assertion about the whole script body.
    const releaseRefRun = stepRun(releaseRefStep)
    requireCondition(
      releaseRefRun.includes('refs/tags/$REQUESTED_REF') &&
        releaseRefRun.includes('refs/remotes/origin/main') &&
        releaseRefRun.includes('git merge-base --is-ancestor') &&
        releaseRefRun.includes('git checkout --detach'),
      'validate must reject non-tag dispatch refs and require the tag commit to be on main',
    )
  }

  const setupNodeStep = findStep(validate, (step) => stepUses(step, 'actions/setup-node@'))
  requireStep('validate', 'configure actions/setup-node', setupNodeStep)
  if (setupNodeStep) {
    // setup-node's package-manager-cache input is supported by the pinned
    // action and disables automatic caching; `cache` must also stay unset so
    // the release gate cannot opt into explicit dependency caching.
    const setupNodeWith = asMapping(setupNodeStep.with)
    const packageManagerCacheDisabled = setupNodeWith['package-manager-cache']
    requireCondition(
      packageManagerCacheDisabled === false,
      'validate setup-node must disable automatic package-manager caching',
    )
    requireCondition(
      !Object.hasOwn(setupNodeWith, 'cache'),
      'validate setup-node must not enable explicit dependency caching',
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
    findStepById(attest, 'explain-attestation-failures'),
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
    asMapping(publish.permissions).attestations === 'read',
    'publish must request attestations: read',
  )
  requireCondition(
    !canMintAttestation(publish.permissions),
    'publish must not request OIDC or attestation write permissions',
  )
  requireCheckoutByValidatedSha('publish', publish)
  requireTagReverification('publish', publish)
  requireCondition(
    steps(publish).every((step) => !stepUses(step, 'softprops/action-gh-release@')),
    'publish must not delegate release asset upload to softprops/action-gh-release',
  )
  requireStepId('publish', publish, 'verify-local-assets', 'verify release assets before upload')
  requireStepId(
    'publish',
    publish,
    'stage-release-assets',
    'stage assets on a draft release before publishing it',
  )
  requireStepId(
    'publish',
    publish,
    'verify-published-assets',
    'download and verify published assets',
  )
  requireStepId(
    'publish',
    publish,
    'move-floating-tag',
    'move the floating major tag before publishing stable releases',
  )
  requireStepId(
    'publish',
    publish,
    'publish-release',
    'publish the draft release only after assets verify and floating tags move',
  )
  requireStepOrder('publish', publish, [
    'stage-release-assets',
    'verify-published-assets',
    'move-floating-tag',
    'publish-release',
  ])
}

function requireCheckoutByValidatedSha(jobName, jobConfig) {
  const checkout = findStep(jobConfig, (step) => stepUses(step, 'actions/checkout@'))
  requireStep(jobName, 'checkout the repository', checkout)
  if (!checkout) return

  requireCondition(
    resolvesToValidateOutput(jobConfig, asMapping(checkout.with).ref, 'release_sha'),
    `${jobName} checkout must use needs.validate.outputs.release_sha`,
  )
}

function requireTagReverification(jobName, jobConfig) {
  requireStepId(
    jobName,
    jobConfig,
    'verify-release-tag',
    're-verify the release tag still points to the validated SHA',
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

checkGlobalTokenPermissions()
checkReleaseWorkflow(loadWorkflow(releaseWorkflowPath).doc)
checkPermissionFixtures()

if (failures.length > 0) {
  console.error('Release provenance policy failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}

console.log('Release provenance policy OK')
