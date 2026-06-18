import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { B2Client, type Bucket } from '@backblaze-labs/b2-sdk'
import { B2Simulator } from '@backblaze-labs/b2-sdk/simulator'
import { uploadCommand } from '../src/commands/upload.ts'
import type { ActionName, ParsedInputs } from '../src/inputs.ts'
import {
  DEFAULT_TEST_BUCKET,
  makeParsedInputs,
  TEST_APPLICATION_KEY,
  TEST_APPLICATION_KEY_ID,
} from './_parsed-inputs.ts'

/**
 * Part size used by the multipart fixture. Small enough that a few-hundred-KB
 * upload triggers the SDK's multipart path (and therefore `contentSha1: null`
 * surfaces, totalParts > 1 in progress events, etc.), but large enough that
 * v8 coverage instrumentation on per-part hashing stays under vitest's RPC
 * timeout on slow CI runners.
 */
export const MULTIPART_PART_SIZE = 100_000

/**
 * Shared base inputs for command tests. Two call shapes:
 *
 *   makeInputs('upload', { source: '...' })
 *   makeInputs('upload', fx, { source: '...' })  // picks bucket from fx
 *
 * The fx-bound form removes the duplication of writing the bucket name once
 * at fixture creation and again in every `makeInputs` call.
 *
 * Keeping the defaults table in one place means adding a new input to
 * `ParsedInputs` only requires updating it here, not every test file.
 */
export function makeInputs(action: ActionName, override?: Partial<ParsedInputs>): ParsedInputs
export function makeInputs(
  action: ActionName,
  fx: TestFixture,
  override?: Partial<ParsedInputs>,
): ParsedInputs
export function makeInputs(
  action: ActionName,
  fxOrOverride: TestFixture | Partial<ParsedInputs> = {},
  maybeOverride: Partial<ParsedInputs> = {},
): ParsedInputs {
  const isFx = 'workDir' in fxOrOverride && 'bucket' in fxOrOverride && 'client' in fxOrOverride
  const fx = isFx ? (fxOrOverride as TestFixture) : undefined
  const override = isFx ? maybeOverride : (fxOrOverride as Partial<ParsedInputs>)
  return makeParsedInputs(action, {
    bucket: fx?.bucket.name ?? DEFAULT_TEST_BUCKET,
    ...override,
  })
}

/** The standard fixture every command test sets up. */
export interface TestFixture {
  workDir: string
  bucket: Bucket
  client: B2Client
  /**
   * The simulator backing this fixture. Exposed so tests can call
   * `fx.sim.injectFailure(...)` to exercise error branches in the action's
   * command code (e.g. `deleteAll` errors, transient 503s).
   */
  sim: B2Simulator
}

/**
 * Build a fresh simulator-backed B2Client + bucket + temp workspace dir.
 * Every command test uses this; centralizing it here means changing the
 * simulator setup is one file, not 9.
 *
 * Pass a `bucketName` to disambiguate parallel tests so they don't collide
 * on the simulator's globally-unique bucket-name space. Defaults to
 * `gh-action-test`.
 *
 * Pass `simOptions` to override the simulator's part-size advertisement.
 * Use {@link MULTIPART_PART_SIZE} for tests that need to force multipart
 * control flow (null contentSha1, totalParts in progress events).
 *
 * The caller is responsible for `rm`-ing `workDir` in their `afterEach`.
 */
export async function makeFixture(
  bucketName = DEFAULT_TEST_BUCKET,
  simOptions: { minimumPartSize?: number; recommendedPartSize?: number } = {},
): Promise<TestFixture> {
  const sim = new B2Simulator(simOptions)
  const client = new B2Client({
    applicationKeyId: TEST_APPLICATION_KEY_ID,
    applicationKey: TEST_APPLICATION_KEY,
    transport: sim.transport(),
  })
  await client.authorize()
  const bucket = await client.createBucket({ bucketName, bucketType: 'allPrivate' })
  const workDir = await mkdtemp(join(tmpdir(), 'b2-test-'))
  return { workDir, bucket, client, sim }
}

/**
 * Shortcut for {@link makeFixture} configured to advertise small part sizes
 * so the SDK takes the multipart upload path for ~200 KB payloads.
 */
export function makeMultipartFixture(bucketName: string): Promise<TestFixture> {
  return makeFixture(bucketName, {
    minimumPartSize: MULTIPART_PART_SIZE,
    recommendedPartSize: MULTIPART_PART_SIZE,
  })
}

/**
 * Curry {@link makeInputs} for a specific verb + fixture so per-test bodies
 * read as `inputs({ source: 'x.txt' })` instead of `makeInputs('verb', fx, { ... })`.
 * Cuts the boilerplate in per-command test files that build many ParsedInputs
 * with the same verb/fixture pair. The returned closure captures `fx` by
 * reference; callers using a `let fx: TestFixture` rebound per-test in a
 * `beforeEach` get the fresh fixture on every call.
 */
export function boundInputs<A extends ActionName>(
  action: A,
  getFx: () => TestFixture,
): (override?: Partial<ParsedInputs>) => ParsedInputs {
  return (override) => makeInputs(action, getFx(), override ?? {})
}

/**
 * Snapshot of `process.env` taken once at module load, before any test runs.
 * Used by {@link resetInputEnv} to put env back to a clean baseline between
 * tests so `parseInputs()` reads from a known-empty slate.
 */
const ORIGINAL_ENV = { ...process.env }

/** Set an `INPUT_*` env var the way `@actions/core` reads it. */
export function setInput(name: string, value: string): void {
  process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value
}

/**
 * Clear every `INPUT_*` env var and restore `process.env` to the snapshot
 * taken at module load. Call from `beforeEach` and `afterEach` whenever a
 * test mutates env vars (e.g. `setInput`, `B2_APPLICATION_KEY_ID`).
 */
export function resetInputEnv(): void {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('INPUT_')) Reflect.deleteProperty(process.env, k)
  }
  process.env = { ...ORIGINAL_ENV }
}

/**
 * Seed one file into the fixture's bucket. Writes `body` to a local temp file
 * under `fx.workDir`, then uploads it to `key` in `fx.bucket`. The local file
 * is left behind (cleaned up when the test's `afterEach` removes `workDir`).
 *
 * Replaces the 3-line `writeFile + uploadCommand` boilerplate that otherwise
 * appears at the start of nearly every command test.
 */
export async function seedFile(fx: TestFixture, key: string, body: string): Promise<void> {
  const local = join(fx.workDir, key.split('/').pop() ?? key)
  await writeFile(local, body)
  await uploadCommand(fx.bucket, makeInputs('upload', fx, { source: local, destination: key }))
}

/** Seed multiple files in one call. Iterates `entries` in declaration order. */
export async function seedFiles(fx: TestFixture, entries: Record<string, string>): Promise<void> {
  for (const [key, body] of Object.entries(entries)) {
    await seedFile(fx, key, body)
  }
}

/**
 * Capture everything `@actions/core` writes during `fn` by intercepting
 * `process.stdout.write`. Returns the concatenated output. Used to verify
 * `core.info` / `core.warning` / `core.error` / `core.setSecret` calls
 * without spying on the module namespace (vitest 4 disallows mutating ESM
 * namespaces, so the old `vi.spyOn(core, 'info')` no longer works).
 */
export async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((data: unknown) => {
    chunks.push(typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString())
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}
