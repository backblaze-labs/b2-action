#!/usr/bin/env node
/**
 * Batched mutation runner.
 *
 * Why this exists: Stryker's vitest runner mis-measures this project when all
 * mutated files are instrumented together in a single run. The repo's tests
 * lean heavily on `vi.resetModules()` + `vi.doMock()` + dynamic `import()`, and
 * at full scale (8 files / ~1500 mutants) the test-runner serves stale,
 * un-mutated modules to the covering tests. The symptom: `src/main.ts` scores
 * 0% in a full run but ~86% when mutated in isolation, dragging the aggregate
 * far below its true value. `coverageAnalysis: "all"` does not fix it, and
 * `maxTestRunnerReuse: 1` crashes esbuild.
 *
 * The fix: run Stryker once per mutated file (where measurement is accurate),
 * then aggregate the per-file JSON reports ourselves and gate on the combined
 * mutation score. Each per-file run is fast and correct; the sum is the true
 * project score.
 *
 * Usage: node scripts/run-batched-mutation.mjs
 * Exits non-zero when the aggregate score is below the configured break
 * threshold (stryker.conf.json -> thresholds.break).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const REPORT = 'reports/mutation/mutation.json'
const BY_FILE_DIR = 'reports/mutation/by-file'
const config = JSON.parse(readFileSync('stryker.conf.json', 'utf8'))
const files = config.mutate ?? []
const threshold = config.thresholds?.break ?? 65

if (files.length === 0) {
  console.error('No files listed in stryker.conf.json "mutate"; nothing to do.')
  process.exit(1)
}

const STATUS_KEYS = ['killed', 'timeout', 'survived', 'noCoverage', 'errors']
const STATUS_MAP = {
  Killed: 'killed',
  Timeout: 'timeout',
  Survived: 'survived',
  NoCoverage: 'noCoverage',
  RuntimeError: 'errors',
  CompileError: 'errors',
}

const zero = () => Object.fromEntries(STATUS_KEYS.map((k) => [k, 0]))
const totals = zero()
const rows = []

mkdirSync(BY_FILE_DIR, { recursive: true })

for (const file of files) {
  console.log(`\n=== mutating ${file} ===`)
  rmSync(REPORT, { force: true })
  try {
    // Per-file break threshold is irrelevant here; we aggregate and gate below.
    // Stryker still writes the JSON report before any threshold-based exit.
    execFileSync(
      'pnpm',
      ['exec', 'stryker', 'run', '--mutate', file, '--reporters', 'clear-text,json'],
      { stdio: 'inherit' },
    )
  } catch {
    // Non-zero exit is expected when a single file is below its break
    // threshold. A genuine crash is caught by the missing-report check below.
  }
  if (!existsSync(REPORT)) {
    console.error(`\nStryker produced no report for ${file}; treating as a hard failure.`)
    process.exit(1)
  }
  // Preserve each file's report; the shared path is overwritten next iteration.
  copyFileSync(REPORT, `${BY_FILE_DIR}/${file.replaceAll('/', '__')}.json`)
  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  const counts = zero()
  for (const f of Object.values(report.files ?? {})) {
    for (const m of f.mutants ?? []) {
      const key = STATUS_MAP[m.status]
      if (key) counts[key] += 1
    }
  }
  rows.push({ file, ...counts, score: score(counts) })
  for (const k of STATUS_KEYS) totals[k] += counts[k]
}

function score({ killed, timeout, survived, noCoverage }) {
  const detected = killed + timeout
  const valid = detected + survived + noCoverage
  return valid === 0 ? 100 : (detected / valid) * 100
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
console.log('\n================= Aggregate mutation report =================')
console.log(
  `${pad('file', 28)}${padL('score', 8)}${padL('killed', 8)}${padL('time', 6)}${padL('surv', 6)}${padL('noCov', 7)}${padL('err', 5)}`,
)
for (const r of rows) {
  console.log(
    `${pad(r.file, 28)}${padL(`${r.score.toFixed(2)}%`, 8)}${padL(r.killed, 8)}${padL(r.timeout, 6)}${padL(r.survived, 6)}${padL(r.noCoverage, 7)}${padL(r.errors, 5)}`,
  )
}
const agg = score(totals)
console.log('-'.repeat(60))
console.log(
  `${pad('ALL', 28)}${padL(`${agg.toFixed(2)}%`, 8)}${padL(totals.killed, 8)}${padL(totals.timeout, 6)}${padL(totals.survived, 6)}${padL(totals.noCoverage, 7)}${padL(totals.errors, 5)}`,
)

// Persist an aggregate summary next to the per-file report for CI artifacts.
mkdirSync('reports/mutation', { recursive: true })
const summary = { score: agg, threshold, totals, files: rows, generatedBy: 'run-batched-mutation' }
writeFileSync('reports/mutation/aggregate.json', JSON.stringify(summary, null, 2))

if (agg < threshold) {
  console.error(
    `\nAggregate mutation score ${agg.toFixed(2)}% is below break threshold ${threshold}.`,
  )
  process.exit(1)
}
console.log(`\nAggregate mutation score ${agg.toFixed(2)}% meets break threshold ${threshold}.`)
