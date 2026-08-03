import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as core from '@actions/core'

/**
 * Expand a leading `~` in a **local** path input to the runner's home
 * directory.
 *
 * Action inputs are not shell-expanded, so `~/.cache/hf` would otherwise
 * resolve against the workspace and create a literal `~` directory. Users
 * arrive expecting `actions/cache` semantics (`~/.npm`, `~/.cache/pip`), and
 * `@actions/glob` already expands `~` in upload patterns, so leaving the other
 * verbs literal made the surface inconsistent.
 *
 * Only the leading segment is expanded, and only for local paths: B2 keys are
 * opaque and may legitimately contain `~`. `~user` forms are not expanded
 * (Node has no API for another user's home) and warn instead of failing.
 */
export function expandTilde(path: string): string
export function expandTilde(path: string | undefined): string | undefined
export function expandTilde(path: string | undefined): string | undefined {
  if (path === undefined || !path.startsWith('~')) return path
  if (path === '~') return homedir()
  const separatorIndex = path.search(/[/\\]/)
  if (separatorIndex === 1) return join(homedir(), path.slice(2))
  core.warning(
    `Local path "${path}" is used as-is: this action expands a leading "~" or "~/" only, ` +
      'not "~user" forms. Use an absolute path or a workspace-relative path instead.',
  )
  return path
}

/**
 * `stat(path)` that returns `undefined` instead of throwing on ENOENT/EACCES
 * etc. Used at filesystem boundaries where the caller wants to distinguish
 * "doesn't exist / not readable" from "exists with shape X" without juggling
 * try/catch at every call site.
 */
export async function tryStat(path: string): Promise<Stats | undefined> {
  return stat(path).catch(() => undefined)
}
