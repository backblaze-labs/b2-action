import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import type { EncryptionSetting } from '@backblaze-labs/b2-sdk'
import { SSE_B2, sseCustomer } from '@backblaze-labs/b2-sdk'

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

/** Options for parsing one action SSE input value. */
export interface ParseSseOptions {
  /** Input name to use in validation errors. */
  inputName?: string
  /** Whether the input accepts SSE-B2. Source SSE-C keys do not. */
  allowB2?: boolean
}

/**
 * Parse an SSE input into an SDK {@link EncryptionSetting}.
 *
 * Accepted forms:
 *   - `undefined` / empty → no encryption setting passed (B2 still applies any
 *      bucket-default SSE-B2; we just don't override it).
 *   - `"B2"` (case-insensitive) → SSE-B2 with the B2-managed key (no cost).
 *   - `"C:<base64-32-byte-key>"` → SSE-C with a customer-provided key. We
 *      compute the required base64 MD5 internally so the workflow author
 *      doesn't have to.
 *
 * The action runs in Node only, so we use `node:crypto.createHash('md5')`
 * directly rather than the SDK's isomorphic key wrapper. We deliberately do
 * NOT log the key bytes; the only place they ever go is into the
 * `customerKey` field of the SDK setting which the SDK marks as a secret in
 * any error / debug output.
 */
export function parseSse(
  raw: string | undefined,
  { inputName = 'sse', allowB2 = true }: ParseSseOptions = {},
): EncryptionSetting | undefined {
  if (raw === undefined || raw === '') return undefined

  const normalized = raw.trim()
  if (normalized.toUpperCase() === 'B2') {
    if (allowB2) return SSE_B2
    throw new Error(`Invalid '${inputName}' input. Expected "C:<base64-32-byte-key>".`)
  }

  if (normalized.startsWith('C:') || normalized.startsWith('c:')) {
    const base64Key = normalized.slice(2).trim()
    if (base64Key === '') {
      throw new Error(
        `Invalid '${inputName}' input: SSE-C key is empty. Use 'C:<base64-32-byte-key>'.`,
      )
    }
    // Node's `Buffer.from(str, 'base64')` silently drops invalid chars instead
    // of throwing, so validate the canonical alphabet and padding first.
    if (!CANONICAL_BASE64.test(base64Key)) {
      throw new Error(
        `Invalid '${inputName}' input: SSE-C key must be valid canonical base64. Use 'C:<base64-32-byte-key>'.`,
      )
    }
    const keyBytes = Buffer.from(base64Key, 'base64')
    if (keyBytes.byteLength !== 32) {
      throw new Error(
        `Invalid '${inputName}' input: SSE-C key must decode to exactly 32 bytes (256 bits); got ${keyBytes.byteLength}.`,
      )
    }
    const customerKey = keyBytes.toString('base64')
    if (customerKey !== base64Key) {
      throw new Error(
        `Invalid '${inputName}' input: SSE-C key must be valid canonical base64. Use 'C:<base64-32-byte-key>'.`,
      )
    }
    const customerKeyMd5 = createHash('md5').update(keyBytes).digest('base64')
    return sseCustomer(customerKey, customerKeyMd5)
  }

  const expected = allowB2 ? '"B2" or "C:<base64-32-byte-key>"' : '"C:<base64-32-byte-key>"'
  const received = allowB2 ? `: "${raw}"` : ''
  throw new Error(`Invalid '${inputName}' input${received}. Expected ${expected}.`)
}
