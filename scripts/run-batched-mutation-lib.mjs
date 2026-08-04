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
export const PER_FILE_CONFIG = 'reports/mutation/stryker-per-file.conf.json'
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
    writePerFileConfig(cwd, config, file)

    try {
      runCommand(command, strykerArgs(), { cwd, stdio: 'inherit' })
    } catch (error) {
      childFailures.push({ file, ...childFailureDetails(error) })
    }

    if (!existsSync(resolve(cwd, REPORT))) {
      stderr(`\nStryker produced no report for ${file}; treating as a hard failure.`)
      return 1
    }

    copyFileSync(resolve(cwd, REPORT), resolve(cwd, BY_FILE_DIR, byFileReportName(file)))
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

  const hardChildFailures = childFailures.filter((failure) => {
    const row = rows.find(({ file }) => file === failure.file)
    return !isPerFileThresholdExit(failure, row, threshold)
  })
  if (hardChildFailures.length > 0) {
    stderr('\nOne or more Stryker subprocesses failed even though a report was produced:')
    for (const failure of hardChildFailures) stderr(`- ${failure.file}: ${failure.message}`)
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

export function strykerArgs() {
  // Stryker 9.x thresholds are config-file only. The wrapper writes this
  // per-file config with thresholds.break disabled, then gates on the aggregate.
  return ['exec', 'stryker', 'run', PER_FILE_CONFIG]
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

function byFileReportName(file) {
  return `${file.replace(/[\\/]/gu, '__')}.json`
}

function writePerFileConfig(cwd, config, file) {
  mkdirSync(resolve(cwd, 'reports/mutation'), { recursive: true })
  const thresholds =
    config.thresholds === undefined
      ? undefined
      : { high: 80, low: 60, ...config.thresholds, break: null }
  writeFileSync(
    resolve(cwd, PER_FILE_CONFIG),
    JSON.stringify(
      {
        ...config,
        mutate: [file],
        reporters: REPORTERS.split(','),
        ...(thresholds === undefined ? {} : { thresholds }),
      },
      null,
      2,
    ),
  )
}

function childFailureDetails(error) {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return {
      message: `exit status ${error.status ?? 'unknown'}`,
      status: typeof error.status === 'number' ? error.status : null,
    }
  }
  if (error instanceof Error) return { message: error.message, status: null }
  return { message: String(error), status: null }
}

function isPerFileThresholdExit(failure, row, threshold) {
  return (
    failure.status === 1 &&
    threshold !== null &&
    row !== undefined &&
    row.score < threshold &&
    row.errors === 0 &&
    row.unknown === 0
  )
}

function printAggregate(rows, totals, stdout) {
  const pad = (value, width) => String(value).padEnd(width)
  const padL = (value, width) => String(value).padStart(width)
  const columns = [
    { key: 'file', header: 'file', width: 28, align: 'left' },
    {
      key: 'score',
      header: 'score',
      width: 8,
      align: 'right',
      format: (value) => `${value.toFixed(2)}%`,
    },
    { key: 'killed', header: 'killed', width: 8, align: 'right' },
    { key: 'timeout', header: 'time', width: 6, align: 'right' },
    { key: 'survived', header: 'surv', width: 6, align: 'right' },
    { key: 'noCoverage', header: 'noCov', width: 7, align: 'right' },
    { key: 'ignored', header: 'ign', width: 5, align: 'right' },
    { key: 'errors', header: 'err', width: 5, align: 'right' },
    { key: 'unknown', header: 'unk', width: 5, align: 'right' },
  ]
  const formatLine = (source, useHeader = false) =>
    columns
      .map((column) => {
        const raw = useHeader ? column.header : source[column.key]
        const value = !useHeader && typeof column.format === 'function' ? column.format(raw) : raw
        return column.align === 'left' ? pad(value, column.width) : padL(value, column.width)
      })
      .join('')
  const lineWidth = columns.reduce((width, column) => width + column.width, 0)

  stdout('\n================= Aggregate mutation report =================')
  stdout(formatLine(null, true))
  for (const row of rows) {
    stdout(formatLine(row))
  }
  const aggregateScore = score(totals)
  stdout('-'.repeat(lineWidth))
  stdout(formatLine({ ...totals, file: 'ALL', score: aggregateScore }))
}
