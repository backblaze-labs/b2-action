import * as core from '@actions/core'
import type { FileVersion } from '@backblaze-labs/b2-sdk'
import { B2Client, type Bucket, type HttpTransport } from '@backblaze-labs/b2-sdk'
import { VERSION } from './version.ts'

/**
 * An authorized B2Client paired with the bucket name the action is scoped
 * to. Returned by {@link buildClient}; consumed by command dispatch sites
 * that need either the high-level client (cross-bucket copy, presign) or
 * the resolved bucket (via {@link getBucket}).
 */
export interface AuthorizedClient {
  /** The authorized SDK client. `client.accountInfo` is populated. */
  client: B2Client
  /** The destination bucket name as provided to the action's `bucket` input. */
  bucketName: string
}

/** Inputs to {@link buildClient}. */
export interface BuildClientOptions {
  /** B2 application key ID. Masked via `core.setSecret` by the dispatcher (defense in depth). */
  applicationKeyId: string
  /** B2 application key (the secret). Masked via `core.setSecret` by the dispatcher. */
  applicationKey: string
  /** Target bucket name (stored on the result for later `getBucket` resolution). */
  bucket: string
  /** Override the default B2 realm endpoint. Only set for staging / custom realms. */
  endpoint?: string | undefined
  /** Inject a custom transport (used by tests with the SDK's `B2Simulator`). */
  transport?: HttpTransport | undefined
}

/**
 * Build an authorized B2Client.
 *
 * Steps:
 *   1. Construct the client with `userAgent: 'b2-github-action/<version>'`. The
 *      SDK preserves its own `b2-sdk-typescript/` and `@backblaze-labs/b2-sdk` tokens before
 *      ours so Backblaze server-side logs see both attribution layers.
 *   2. `await client.authorize()`. This is one-shot for the lifetime of the
 *      action invocation. B2 auth tokens carry a 24h TTL; typical GitHub
 *      Actions runs finish well inside that window. If a long-running job
 *      outlives the token, the SDK transparently re-authorizes on the next
 *      401, so the action layer does not need its own refresh loop.
 *   3. Mask the resulting authorization token via `core.setSecret` so any later
 *      log line that happens to include it (errors, debug traces) is redacted.
 *
 * The `transport` parameter is only used by tests (the SDK's B2Simulator
 * provides one). Production callers leave it undefined to use the SDK's
 * default FetchTransport with its built-in SSRF guard.
 */
export async function buildClient(options: BuildClientOptions): Promise<AuthorizedClient> {
  const userAgent = `b2-github-action/${VERSION}`

  const client = new B2Client({
    applicationKeyId: options.applicationKeyId,
    applicationKey: options.applicationKey,
    userAgent,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.endpoint !== undefined ? { realm: options.endpoint } : {}),
  })

  await client.authorize()

  const token = client.accountInfo.getAuthToken()
  if (token) core.setSecret(token)

  return { client, bucketName: options.bucket }
}

/**
 * Resolve a bucket by name. Throws a clear error rather than the SDK's
 * `undefined` return so the workflow log surfaces the misconfiguration.
 */
export async function getBucket(authorized: AuthorizedClient) {
  const bucket = await authorized.client.getBucket(authorized.bucketName)
  if (!bucket) {
    throw new Error(
      `Bucket "${authorized.bucketName}" not found, or the application key lacks listBuckets capability for it.`,
    )
  }
  return bucket
}

/**
 * Resolve an exact file name only when its latest version is an upload. If the
 * latest exact-name version is a hide marker, this intentionally reports the
 * file as not found instead of selecting an older upload from version history
 * or revealing hidden-object existence in default workflow logs. Throws when
 * the latest exact-name state is hidden, deleted, or absent. Used by `copy`,
 * `delete`, and `retention` to resolve a file name to a `fileId` before
 * operating on it.
 *
 * Consistency assumption: B2's `listFileNames` is read-after-write consistent
 * for a recently-uploaded file in the same region. The simulator returns
 * uploads immediately; production B2 in practice does the same, but a caller
 * that chains "upload then operate on the same name" across two action steps
 * is relying on observed behavior rather than a documented SLA.
 *
 * @param bucket - The bucket to search.
 * @param fileName - Exact file name (path) to look up.
 * @param bucketDisplayName - Optional label for the error message; defaults
 *   to `bucket.name`. Used when looking up in a source bucket distinct from
 *   the action's destination bucket (cross-bucket copy).
 */
export async function findFileByName(
  bucket: Bucket,
  fileName: string,
  bucketDisplayName?: string,
): Promise<FileVersion> {
  const display = bucketDisplayName ?? bucket.name
  const page = await bucket.listFileNames({ prefix: fileName, pageSize: 1 })
  const exactLatest = page.files.find((f) => f.fileName === fileName)
  if (exactLatest?.action === 'upload') return exactLatest

  throw new Error(`File not found in bucket "${display}": ${fileName}`)
}
