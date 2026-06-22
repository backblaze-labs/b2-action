import { appendFile } from 'node:fs/promises'
import * as core from '@actions/core'
import { formatBytes } from './format.ts'

/** Maximum per-file rows rendered in a GitHub Actions step summary table. */
export const STEP_SUMMARY_MAX_ROWS = 100

/**
 * Append a markdown summary block to `$GITHUB_STEP_SUMMARY`.
 *
 * The summary file is the standard way for an Action to publish output that
 * shows up in the workflow run's summary page (rather than just the live log).
 * We use it to print a per-file table after upload / download / sync / delete
 * so users can see at-a-glance what happened without scrolling through the
 * `::group::` log lines.
 *
 * If the env var is unset (e.g. running the bundle locally for a smoke test),
 * we no-op. We deliberately do not throw: a missing summary file is never
 * a reason to fail an otherwise-successful step.
 */
/**
 * One row in the `$GITHUB_STEP_SUMMARY` table emitted by a verb. Only
 * `fileName` is required; the other cells render empty when omitted.
 */
export interface SummaryRow {
  /** B2 file name or display label (e.g. `(uploaded)`, `(removed)`). */
  fileName: string
  /** Byte size of the file. Rendered via {@link formatBytes}. */
  size?: number | undefined
  /** B2 file ID (rendered as inline code). */
  fileId?: string | undefined
  /** Content SHA-1. Truncated to 12 chars in the table for readability. */
  sha1?: string | null | undefined
  /** Free-form status cell (e.g. `uploaded`, `would delete`, `deleted`). */
  status?: string | undefined
}

/**
 * Append a markdown summary block to `$GITHUB_STEP_SUMMARY`. No-ops when
 * the env var is unset (e.g. running the bundle locally for a smoke test).
 *
 * @param opts.title - Heading rendered as `## {title}`.
 * @param opts.rows - One row per file. Empty rows render an empty table body.
 * @param opts.totals - Optional aggregate line printed above the table.
 * @param opts.totalRows - Optional source row count when callers pre-slice rows.
 */
export async function writeStepSummary(opts: {
  title: string
  rows: readonly SummaryRow[]
  totals?: { files: number; bytes: number } | undefined
  totalRows?: number | undefined
}): Promise<void> {
  const path = process.env.GITHUB_STEP_SUMMARY
  if (path === undefined || path === '') return

  // Keep the writer defensive for direct callers even though dispatcher
  // call sites pre-slice rows to avoid mapping very large result sets.
  const rows = opts.rows.slice(0, STEP_SUMMARY_MAX_ROWS)
  const totalRows = opts.totalRows ?? opts.rows.length
  const lines: string[] = []
  lines.push(`## ${opts.title}`)
  lines.push('')

  if (opts.totals !== undefined) {
    lines.push(`**${opts.totals.files}** files, **${formatBytes(opts.totals.bytes)}** total.`)
    lines.push('')
  }

  if (totalRows > rows.length) {
    lines.push(`Showing first ${rows.length} of ${totalRows} rows.`)
    lines.push('')
  }

  if (rows.length > 0) {
    lines.push('| File | Size | File ID | SHA-1 | Status |')
    lines.push('|------|------|---------|-------|--------|')
    for (const r of rows) {
      lines.push(
        `| ${inlineCodeCell(r.fileName)} | ${r.size !== undefined ? formatBytes(r.size) : ''} | ${
          r.fileId !== undefined ? inlineCodeCell(r.fileId) : ''
        } | ${r.sha1 !== undefined && r.sha1 !== null ? `\`${r.sha1.slice(0, 12)}…\`` : ''} | ${
          r.status ?? ''
        } |`,
      )
    }
  }

  lines.push('')

  try {
    await appendFile(path, `${lines.join('\n')}\n`)
  } catch (err) {
    // $GITHUB_STEP_SUMMARY might point at an unwritable path (e.g. a
    // directory, or a file the runner lacks permission to extend). The
    // summary is informational; degrading to a warning is better than
    // failing an otherwise-successful step.
    core.warning(`Failed to write step summary: ${(err as Error).message}`)
  }
}

function inlineCodeCell(value: string): string {
  return `<code>${escapeHtml(value).replaceAll('|', '&#124;')}</code>`
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
