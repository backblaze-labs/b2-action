/**
 * Pure helpers for scripts/changelog-check.mjs, kept free of a shebang and side effects so tests
 * can import them on every platform.
 */

// Paths whose change reaches consumers: the Action itself, its bundle and dependencies, and the
// workflows and composite actions that build and release it (#177).
export const SHIPPED_PATHS = [
  'src/',
  'dist/',
  'action.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.github/workflows/',
  '.github/actions/',
]

export function isShipped(file) {
  return SHIPPED_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))
}

export function isUnreleasedFragment(file) {
  return /^\.changes\/unreleased\/[^/]+\.yaml$/.test(file)
}

export function isVersionFile(file) {
  return /^\.changes\/v[^/]+\.md$/.test(file)
}

/** A fragment counts only with a non-empty kind and body. */
export function isValidFragment(parsed) {
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    typeof parsed.kind === 'string' &&
    parsed.kind.trim() !== '' &&
    typeof parsed.body === 'string' &&
    parsed.body.trim() !== ''
  )
}

/** Batched notes count only for the version being released, with at least one entry. */
export function isValidReleaseNotes(file, text, packageVersion) {
  return file === `.changes/v${packageVersion}.md` && /^- \S/m.test(text)
}

export function missingEntry(changedFiles, validEntryCount) {
  return changedFiles.some(isShipped) && validEntryCount === 0
}
