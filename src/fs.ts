import type { Stats } from 'node:fs'
import { stat } from 'node:fs/promises'

/**
 * `stat(path)` that returns `undefined` instead of throwing on ENOENT/EACCES
 * etc. Used at filesystem boundaries where the caller wants to distinguish
 * "doesn't exist / not readable" from "exists with shape X" without juggling
 * try/catch at every call site.
 */
export async function tryStat(path: string): Promise<Stats | undefined> {
  return stat(path).catch(() => undefined)
}
