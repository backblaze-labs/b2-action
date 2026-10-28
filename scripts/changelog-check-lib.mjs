/**
 * Pure helpers for scripts/changelog-check.mjs, kept free of a shebang and side effects so tests
 * can import them on every platform.
 */

export const SHIPPED_PATHS = [
  'src/',
  'dist/',
  'action.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]

export function isShipped(file) {
  return SHIPPED_PATHS.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p))
}

export function isFragment(file) {
  return /^\.changes\/(unreleased\/[^/]+\.yaml|v[^/]+\.md)$/.test(file)
}

export function missingEntry(changedFiles, addedFiles) {
  return changedFiles.some(isShipped) && !addedFiles.some(isFragment)
}
