import type { ActionName, ParsedInputs } from '../src/inputs.ts'

export const TEST_APPLICATION_KEY_ID = 'test-key-id'
export const TEST_APPLICATION_KEY = 'test-key'
export const TEST_ENDPOINT = 'https://staging.example'
export const DEFAULT_TEST_BUCKET = 'gh-action-test'

export function makeParsedInputs(
  action: ActionName,
  override: Partial<ParsedInputs> = {},
): ParsedInputs {
  return {
    action,
    applicationKeyId: TEST_APPLICATION_KEY_ID,
    applicationKey: TEST_APPLICATION_KEY,
    bucket: DEFAULT_TEST_BUCKET,
    sourceBucket: undefined,
    source: undefined,
    destination: undefined,
    include: [],
    exclude: [],
    concurrency: 2,
    partSize: undefined,
    resume: true,
    contentType: undefined,
    dryRun: false,
    allowBucketPurge: false,
    presignTtlSeconds: 3600,
    endpoint: undefined,
    failOnEmpty: true,
    sse: undefined,
    encryption: undefined,
    compareMode: 'modtime',
    keepMode: 'no-delete',
    syncDirection: 'auto',
    maxResults: 1000,
    expectedSha1: undefined,
    retentionMode: undefined,
    retentionUntil: undefined,
    legalHold: undefined,
    bypassGovernance: false,
    ...override,
  }
}
