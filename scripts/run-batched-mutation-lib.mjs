/**
 * Batched mutation runner.
 *
 * Why this exists: Stryker's vitest runner mis-measures this project when all
 * mutated files are instrumented together in a single run. The repo's tests
 * lean heavily on `vi.resetModules()` + `vi.doMock()` + dynamic `import()`, and
 * at full scale the test runner can serve stale, un-mutated modules to the
 * covering tests. The fix is to run Stryker once per mutated file, then
 * aggregate the per-file JSON reports and gate on the combined mutation score.
 *
 * The constants below are the wrapper-owned reporting contract. If Stryker's
 * JSON reporter filename, reporter names, or mutant status strings change,
 * update them here and in the runner tests.
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPORT = 'reports/mutation/mutation.json'
export const BY_FILE_DIR = 'reports/mutation/by-file'
export const REPORTERS = 'clear-text,json'
export const STATUS_KEYS = Object.freeze([
  'killed',
  'timeout',
  'survived',
  'noCoverage',
  'ignored',
  'errors',
  'unknown',
])
export const STATUS_MAP = Object.freeze({
  CompileError: 'errors',
  Ignored: 'ignored',
  Killed: 'killed',
  NoCoverage: 'noCoverage',
  RuntimeError: 'errors',
  Survived: 'survived',
  Timeout: 'timeout',
})

export function main() {
  const exitCode = runBatchedMutation()
  if (exitCode !== 0) process.exit(exitCode)
}

export function runBatchedMutation({
  command = defaultPnpmCommand(),
  cwd = process.cwd(),
  runCommand = execFileSync,
  stdout = console.log,
  stderr = console.error,
} = {}) {
  const config = JSON.parse(readFileSync(resolve(cwd, 'stryker.conf.json'), 'utf8'))
  const files = config.mutate ?? []
  const threshold = numericThreshold(config.thresholds?.break)

  if (files.length === 0) {
    stderr('No files listed in stryker.conf.json "mutate"; nothing to do.')
    return 1
  }

  const totals = zero()
  const rows = []
  const childFailures = []
  const unknownStatuses = new Map()

  rmSync(resolve(cwd, BY_FILE_DIR), { force: true, recursive: true })
  mkdirSync(resolve(cwd, BY_FILE_DIR), { recursive: true })

  for (const file of files) {
    stdout(`\n=== mutating ${file} ===`)
    rmSync(resolve(cwd, REPORT), { force: true })

    try {
      runCommand(command, strykerArgs(file), { cwd, stdio: 'inherit' })
    } catch (error) {
      childFailures.push({ file, message: childFailureMessage(error) })
    }

    if (!existsSync(resolve(cwd, REPORT))) {
      stderr(`\nStryker produced no report for ${file}; treating as a hard failure.`)
      return 1
    }

    copyFileSync(
      resolve(cwd, REPORT),
      resolve(cwd, BY_FILE_DIR, `${file.replaceAll('/', '__')}.json`),
    )
    const report = JSON.parse(readFileSync(resolve(cwd, REPORT), 'utf8'))
    const counts = countsForReport(report, unknownStatuses)
    rows.push({ file, ...counts, score: score(counts) })
    for (const key of STATUS_KEYS) totals[key] += counts[key]
  }

  printAggregate(rows, totals, stdout)

  const aggregateScore = score(totals)
  mkdirSync(resolve(cwd, 'reports/mutation'), { recursive: true })
  const summary = {
    score: aggregateScore,
    threshold,
    totals,
    files: rows,
    generatedBy: 'run-batched-mutation',
  }
  writeFileSync(resolve(cwd, 'reports/mutation/aggregate.json'), JSON.stringify(summary, null, 2))

  if (childFailures.length > 0) {
    stderr('\nOne or more Stryker subprocesses failed even though a report was produced:')
    for (const failure of childFailures) stderr(`- ${failure.file}: ${failure.message}`)
    return 1
  }

  if (totals.errors > 0) {
    stderr(`\nStryker reported ${totals.errors} errored mutant(s); treating as a hard failure.`)
    return 1
  }

  if (totals.unknown > 0) {
    stderr('\nStryker reported unknown mutant status values; treating as a hard failure:')
    for (const [status, count] of unknownStatuses) stderr(`- ${status}: ${count}`)
    return 1
  }

  if (threshold !== null && aggregateScore < threshold) {
    stderr(
      `\nAggregate mutation score ${aggregateScore.toFixed(2)}% is below break threshold ${threshold}.`,
    )
    return 1
  }

  if (threshold === null) {
    stdout(
      `\nAggregate mutation score ${aggregateScore.toFixed(2)}%; no break threshold configured.`,
    )
  } else {
    stdout(
      `\nAggregate mutation score ${aggregateScore.toFixed(2)}% meets break threshold ${threshold}.`,
    )
  }
  return 0
}

export function strykerArgs(file) {
  // No `--thresholds.break` here: Stryker 9.x removed dot-notation CLI options,
  // so passing it makes the per-file run fail with "unknown option". A per-file
  // run dropping below the configured break threshold is expected and harmless
  // (the caller catches the non-zero exit and gates on the aggregate instead).
  return ['exec', 'stryker', 'run', '--mutate', file, '--reporters', REPORTERS]
}

export function defaultPnpmCommand(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

export function countsForReport(report, unknownStatuses = new Map()) {
  const counts = zero()
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      const key = STATUS_MAP[mutant.status]
      if (key === undefined) {
        counts.unknown += 1
        const status = String(mutant.status)
        unknownStatuses.set(status, (unknownStatuses.get(status) ?? 0) + 1)
      } else {
        counts[key] += 1
      }
    }
  }
  return counts
}

export function score({ killed, timeout, survived, noCoverage, errors, unknown }) {
  const detected = killed + timeout
  const total = detected + survived + noCoverage + errors + unknown
  return total === 0 ? 100 : (detected / total) * 100
}

export function numericThreshold(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function isEntrypoint(metaUrl, argv1) {
  if (argv1 === undefined) return false
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1))
  } catch {
    return false
  }
}

function zero() {
  return Object.fromEntries(STATUS_KEYS.map((key) => [key, 0]))
}

function childFailureMessage(error) {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return `exit status ${error.status ?? 'unknown'}`
  }
  if (error instanceof Error) return error.message
  return String(error)
}

function printAggregate(rows, totals, stdout) {
  const pad = (value, width) => String(value).padEnd(width)
  const padL = (value, width) => String(value).padStart(width)

  stdout('\n================= Aggregate mutation report =================')
  stdout(
    `${pad('file', 28)}${padL('score', 8)}${padL('killed', 8)}${padL('time', 6)}${padL('surv', 6)}${padL('noCov', 7)}${padL('ign', 5)}${padL('err', 5)}${padL('unk', 5)}`,
  )
  for (const row of rows) {
    stdout(
      `${pad(row.file, 28)}${padL(`${row.score.toFixed(2)}%`, 8)}${padL(row.killed, 8)}${padL(row.timeout, 6)}${padL(row.survived, 6)}${padL(row.noCoverage, 7)}${padL(row.ignored, 5)}${padL(row.errors, 5)}${padL(row.unknown, 5)}`,
    )
  }
  const aggregateScore = score(totals)
  stdout('-'.repeat(70))
  stdout(
    `${pad('ALL', 28)}${padL(`${aggregateScore.toFixed(2)}%`, 8)}${padL(totals.killed, 8)}${padL(totals.timeout, 6)}${padL(totals.survived, 6)}${padL(totals.noCoverage, 7)}${padL(totals.ignored, 5)}${padL(totals.errors, 5)}${padL(totals.unknown, 5)}`,
  )
}
