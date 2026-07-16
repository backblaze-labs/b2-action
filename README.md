# Backblaze B2 GitHub Action

[![CI](https://github.com/backblaze-labs/b2-action/actions/workflows/ci.yml/badge.svg)](https://github.com/backblaze-labs/b2-action/actions/workflows/ci.yml) [![Release](https://github.com/backblaze-labs/b2-action/actions/workflows/release.yml/badge.svg)](https://github.com/backblaze-labs/b2-action/actions/workflows/release.yml) [![Marketplace](https://img.shields.io/github/v/release/backblaze-labs/b2-action?label=marketplace&color=red&logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/backblaze-b2-cloud-storage-action) [![Latest release](https://img.shields.io/github/v/release/backblaze-labs/b2-action?display_name=tag&sort=semver&color=blue)](https://github.com/backblaze-labs/b2-action/releases/latest) [![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE) [![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](./vitest.config.ts) [![Docs](https://img.shields.io/github/deployments/backblaze-labs/b2-action/github-pages?label=docs&logo=readthedocs&logoColor=white)](https://backblaze-labs.github.io/b2-action/)

A Backblaze-maintained B2 GitHub Action. TypeScript-native, built on [@backblaze-labs/b2-sdk](https://github.com/backblaze-labs/b2-sdk-typescript). Sixteen verbs covering every B2 operation a CI workflow needs. Currently incubating in [Backblaze Labs](https://github.com/backblaze-labs).

- **Node 24 action.** No Docker. Sub-second cold start.
- **Sixteen verbs.** `upload`, `download`, `sync`, `copy`, `delete`, `list`, `hide`, `unhide`, `verify`, `presign`, `retention`, `head`, `purge`, `create-key`, `list-keys`, `delete-key`: pick via the `action` input.
- **Resumable multipart uploads** for any file size; streaming I/O so multi-GB payloads don't buffer in RAM.
- **Server-side everything.** `copy` (same-bucket or cross-bucket) and `delete` operations stay server-side; bytes never traverse the runner.
- **Server-side encryption.** SSE-B2 (managed) and SSE-C (customer key, base64).
- **Object Lock.** Governance/compliance retention + legal hold via the `retention` verb.
- **Bi-directional sync.** Local → B2 *and* B2 → local, with auto-detect.
- **Structured outputs.** `file-id`, `content-sha1`, `bytes-transferred`, `files-listed`, `presigned-url`, `verified`, `summary-json`, more.
- **Step-summary tables** rendered on every run via `$GITHUB_STEP_SUMMARY`, capped at 100 per-file rows with an omitted-row notice.
- **Secret-safe.** App keys, auth tokens, and presigned URLs are auto-masked with `::add-mask::`.

> **Live test suite = the examples.** Every workflow under [.github/workflows/example-*.yml](./.github/workflows/README.md) is both a copy-paste-runnable example and an integration test that runs on every PR.

## Table of contents

- [Backblaze B2 GitHub Action](#backblaze-b2-github-action)
  - [Table of contents](#table-of-contents)
  - [Quick start](#quick-start)
  - [Pinning and versioning](#pinning-and-versioning)
  - [Verbs](#verbs)
  - [Worked examples](#worked-examples)
    - [Upload a single file](#upload-a-single-file)
    - [Upload a directory with globs](#upload-a-directory-with-globs)
    - [Download a file or a prefix](#download-a-file-or-a-prefix)
    - [Sync (both directions)](#sync-both-directions)
    - [Server-side copy (same-bucket or cross-bucket)](#server-side-copy-same-bucket-or-cross-bucket)
    - [List, dry-run-delete, delete](#list-dry-run-delete-delete)
    - [Hide / unhide](#hide--unhide)
    - [Verify SHA-1 without downloading](#verify-sha-1-without-downloading)
    - [Presign a download URL](#presign-a-download-url)
    - [Server-side encryption](#server-side-encryption)
      - [Generating an SSE-C key](#generating-an-sse-c-key)
    - [Object Lock retention + legal hold](#object-lock-retention--legal-hold)
    - [Application keys](#application-keys)
    - [Chain outputs](#chain-outputs)
  - [Inputs (full reference)](#inputs-full-reference)
  - [Outputs (full reference)](#outputs-full-reference)
  - [Other Backblaze B2 Actions on the Marketplace](#other-backblaze-b2-actions-on-the-marketplace)
  - [Development \& contributing](#development--contributing)
  - [Running locally from the CLI](#running-locally-from-the-cli)
  - [License](#license)

---

## Quick start

```yaml
- uses: backblaze-labs/b2-action@v1 # tip: pin to a commit SHA for production; see Pinning and versioning
  with:
    action: upload
    application-key-id: ${{ secrets.B2_APPLICATION_KEY_ID }}
    application-key: ${{ secrets.B2_APPLICATION_KEY }}
    bucket: my-bucket
    source: ./build/app.tar.gz
    destination: releases/${{ github.ref_name }}/app.tar.gz
```

For one self-contained example per verb (each is also a live integration test), see [.github/workflows/](./.github/workflows/README.md). Below is the full reference.

---

## Pinning and versioning

This Action follows [semantic versioning](https://semver.org) and maintains a floating major tag. Pick the ref style that matches your risk tolerance:

- **`@v1`** tracks the latest `1.x` release. It is convenient and picks up patches automatically, but it is a **mutable** tag: it is moved to each new release, so the code that runs can change without any change to your workflow.
- **`@vX.Y.Z`** is a pinned, SSH-signed release tag, so it shows as **Verified** on GitHub and is easy to audit. Note that a Git tag is still a movable ref, so treat this as a stable, verifiable pointer rather than an immutability guarantee.
- **`@<full-commit-sha>`** is fully immutable and is what we recommend for anything beyond experimentation. It guarantees the exact code that runs cannot change underneath you, even if a tag is moved. If you enable [Dependabot](https://docs.github.com/en/code-security/dependabot) GitHub Actions updates in your repository, it keeps SHA pins current and rewrites the trailing version comment for you.

```yaml
# Recommended for production: pin to a full-length commit SHA.
# With Dependabot GitHub Actions updates enabled, it bumps the SHA + comment for you.
- uses: backblaze-labs/b2-action@<commit-sha> # vX.Y.Z
```

This is the same supply-chain practice this Action applies to its own workflows: every third-party action it depends on is SHA-pinned. The worked examples below use `@v1` for brevity; swap in a commit SHA (or a pinned `@vX.Y.Z`) for production workflows.

Exact-version releases publish an attested `dist/index.js` asset for provenance checks; see [RELEASE.md](./RELEASE.md#verifying-release-provenance).

---

## Verbs

| Verb | What it does | Required inputs |
| --- | --- | --- |
| `upload` | Single-file or glob upload. Streams the file from disk so multi-GB payloads stay memory-bounded; auto-routes to multipart for large files. | `source`, `bucket` |
| `download` | Single-file or prefix-bulk download. | `source`, `bucket` |
| `sync` | Mirror a local directory ↔ a B2 prefix. Direction auto-detected. | `source`, `destination`, `bucket` |
| `copy` | Server-side copy. Same bucket by default; cross-bucket with `source-bucket`. | `source`, `destination`, `bucket` |
| `delete` | Single file by name, or prefix-bulk via `b2_list_file_versions`. Supports `dry-run` and `bypass-governance` for governance-retained versions. | `source`, `bucket` |
| `list` | List files under a prefix; emits JSON for downstream steps. | `bucket` (and usually `source`) |
| `hide` | Soft-delete via hide marker. Underlying data preserved until lifecycle. | `source`, `bucket` |
| `unhide` | Restore a hidden file by deleting its top hide marker. | `source`, `bucket` |
| `verify` | HEAD-request the remote whole-file SHA-1 and compare to `expected-sha1` or `destination` (local file). No body transfer; multipart objects cannot be verified when B2 does not expose a whole-file SHA-1. | `source`, `bucket`, plus one of `expected-sha1` / `destination` |
| `presign` | Time-limited download URL via `b2_get_download_authorization`. The live URL is masked and exposed only as `presigned-url`; prefix mode exposes only the first generated URL. | `source`, `bucket` |
| `retention` | Apply Object Lock retention + legal hold to a file. | `source`, `bucket`, plus `retention-mode` and/or `legal-hold` |
| `head` | Fetch object metadata (size, sha1, contentType, fileInfo) via HEAD. No body transfer. | `source`, `bucket` |
| `purge` | Permanently delete every file version under a prefix, including hide markers and history. Whole-bucket purge requires `allow-bucket-purge: true`. Supports `dry-run` and `bypass-governance` for governance-retained versions. | `source` or `allow-bucket-purge`, `bucket` |
| `create-key` | Create a B2 application key, optionally bucket/prefix scoped and time-limited. The returned secret is masked and emitted only as `application-key`. | `key-name`, `capabilities` |
| `list-keys` | List B2 application keys without secrets. | |
| `delete-key` | Delete a B2 application key by ID. | `target-application-key-id` |

Exact-name `copy`, single-file `delete`, and `retention` operate only when the latest exact-name version is an upload. If that latest version is a hide marker, these commands do not search older upload history under the same name; they fail with the same `File not found` diagnostic used for absent names so default workflow logs do not reveal hidden-object existence. Run `unhide` first to restore the prior upload, or use `purge` when you need to remove hide markers and historical versions.

---

## Worked examples

> These examples use `@v1` for brevity. For production, pin to a commit SHA; see [Pinning and versioning](#pinning-and-versioning).

### Upload a single file

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    application-key-id: ${{ secrets.B2_APPLICATION_KEY_ID }}
    application-key: ${{ secrets.B2_APPLICATION_KEY }}
    bucket: my-bucket
    source: ./build/app.tar.gz
    destination: releases/${{ github.ref_name }}/app.tar.gz
```

### Upload with metadata and content headers

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    application-key-id: ${{ secrets.B2_APPLICATION_KEY_ID }}
    application-key: ${{ secrets.B2_APPLICATION_KEY }}
    bucket: my-bucket
    source: ./build/app.tar.gz
    destination: releases/${{ github.sha }}/app.tar.gz
    content-type: application/gzip
    file-info: |
      build_sha=${{ github.sha }}
      source_ref=${{ github.ref_name }}
      owner=release-engineering
    cache-control: public, max-age=31536000, immutable
    content-disposition: attachment; filename="app.tar.gz"
    preserve-mtime: true
```

### Upload a directory with globs

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    application-key-id: ${{ secrets.B2_APPLICATION_KEY_ID }}
    application-key: ${{ secrets.B2_APPLICATION_KEY }}
    bucket: my-bucket
    source: ./dist
    destination: site/
    exclude: '**/*.map, .git/**'
```

### Download a file or a prefix

```yaml
# Single file
- uses: backblaze-labs/b2-action@v1
  with:
    action: download
    bucket: my-bucket
    source: cache/node_modules.tar
    destination: ./node_modules.tar

# Prefix (note the trailing slash)
- uses: backblaze-labs/b2-action@v1
  with:
    action: download
    bucket: my-bucket
    source: releases/v1.2.3/
    destination: ./downloads
```

### Sync (both directions)

```yaml
# Auto: local-dir source → upload sync. Remote prefix → download sync.
- uses: backblaze-labs/b2-action@v1
  with:
    action: sync
    bucket: my-bucket
    source: ./public
    destination: site
    compare-mode: modtime
    keep-mode: delete   # remove remote files not present locally

# Force B2 → local (cache restore)
- uses: backblaze-labs/b2-action@v1
  with:
    action: sync
    bucket: my-bucket
    source: caches/${{ runner.os }}
    destination: ./.cache
    direction: down
```

### Server-side copy (same-bucket or cross-bucket)

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: copy
    bucket: my-bucket
    source: releases/v1.2.3/app.tar.gz
    destination: releases/latest/app.tar.gz

# Cross-bucket: promote staging → prod
- uses: backblaze-labs/b2-action@v1
  with:
    action: copy
    bucket: my-prod-bucket          # destination
    source-bucket: my-staging-bucket # source
    source: app.tar.gz
    destination: app.tar.gz
```

### List, dry-run-delete, delete

```yaml
- id: ls
  uses: backblaze-labs/b2-action@v1
  with:
    action: list
    bucket: my-bucket
    source: tmp/
    max-results: 5000

- uses: backblaze-labs/b2-action@v1
  with:
    action: delete
    bucket: my-bucket
    source: tmp/
    dry-run: true
```

### Hide / unhide

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: hide
    bucket: my-bucket
    source: legacy/old.tar.gz

- uses: backblaze-labs/b2-action@v1
  with:
    action: unhide
    bucket: my-bucket
    source: legacy/old.tar.gz
```

### Verify SHA-1 without downloading

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: verify
    bucket: my-bucket
    source: releases/v1.2.3/app.tar.gz
    destination: ./app.tar.gz          # compare to local file
    # OR pin to a known-good literal from your release manifest:
    # expected-sha1: 3b1d2e8c9...
```

`verify` is HEAD-only: it compares against the whole-file SHA-1 that B2 exposes
in object metadata. Multipart-uploaded objects may have no whole-file SHA-1 in
B2, so `verify` cannot validate them without downloading and hashing the object;
supplying `expected-sha1` does not help when the remote digest is unavailable.
When B2 reports a non-comparable remote SHA-1 such as `none` or
`unverified:<sha1>`, `verify` publishes `verified=false` outputs before failing
the step; comparable SHA-1 mismatches also fail.

### Presign a download URL

```yaml
- id: link
  uses: backblaze-labs/b2-action@v1
  with:
    action: presign
    bucket: my-bucket
    source: reports/2026-q1.pdf
    presign-ttl: 7200

- run: curl -fSL "${{ steps.link.outputs.presigned-url }}" -o report.pdf
```

### Server-side encryption

```yaml
# SSE-B2 (B2-managed key, no cost)
- uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    bucket: my-bucket
    source: ./private.tar.gz
    destination: private.tar.gz
    sse: B2

# SSE-C (customer-provided 256-bit key, base64)
- uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    bucket: my-bucket
    source: ./secret.tar.gz
    destination: secret.tar.gz
    sse: C:${{ secrets.B2_SSE_C_KEY_B64 }}
```

#### Generating an SSE-C key

The `sse: C:<value>` input expects a **base64-encoded 32-byte (256-bit) key**. Generate one with:

```bash
openssl rand -base64 32
```

That outputs ~44 characters. Paste the generated value into a GitHub repository secret (`Settings → Secrets and variables → Actions`): convention is `B2_SSE_C_KEY_B64`.

A few things to know before you commit to SSE-C:

- **You own the key, Backblaze does not.** B2 never stores it. **Lose the key, lose the data**: no recovery.
- **The same key must be supplied at download time** as was used at upload. The action's `download` verb takes the same `sse: C:<key>` input.
- **Rotating the key invalidates any existing SSE-C objects** encrypted with the old value. You'd need to download-then-reupload everything with the new key.
- **The action auto-masks the key** in workflow logs via `::add-mask::`, but that masking does not survive copy-paste. Keep secrets out of bug reports.

If you don't need customer-managed keys, **`sse: B2`** (SSE-B2, B2-managed) is the simpler choice and has zero key-loss risk.

### Object Lock retention + legal hold

```yaml
- uses: backblaze-labs/b2-action@v1
  with:
    action: retention
    bucket: my-locked-bucket
    source: audits/2026-q1.tar.gz
    retention-mode: compliance
    retention-until: '2031-04-01T00:00:00Z'
    legal-hold: 'on'
```

Set `bypass-governance: true` to shorten governance-mode retention or to remove governance-retained versions with `delete` or `purge`. The B2 application key must include the `bypassGovernance` capability, in addition to the delete or retention capabilities required by the selected verb.

### Application keys

```yaml
- id: scoped-key
  uses: backblaze-labs/b2-action@v1
  with:
    action: create-key
    key-name: deploy-${{ github.run_id }}
    capabilities: listFiles,readFiles,writeFiles,deleteFiles
    scope-bucket: my-bucket
    name-prefix: releases/${{ github.sha }}/
    valid-duration: 3600

- uses: backblaze-labs/b2-action@v1
  with:
    action: list-keys
    max-results: 100

- uses: backblaze-labs/b2-action@v1
  if: always()
  with:
    action: delete-key
    target-application-key-id: ${{ steps.scoped-key.outputs.application-key-id }}
    key-name: deploy-${{ github.run_id }}
```

`create-key` masks the returned secret before writing the `application-key` output. B2 returns that secret only once; downstream steps should store it in an environment variable or pass it directly to trusted tools that need it. The output is still plaintext in `$GITHUB_OUTPUT` and can be read by later steps in the same job. Do not map it to a job, composite-action, or reusable-workflow output; GitHub does not reliably preserve masking when secrets are propagated that way. Do not enable `ACTIONS_STEP_DEBUG` for `create-key` jobs because the one-time secret can pass through SDK transport internals before the action can register it for masking.
For retry safety, `create-key` refuses to mint a second key when the requested `key-name` already exists. The duplicate-name check is best-effort because B2 does not enforce key-name uniqueness atomically; concurrent same-name runs can both create keys. Use deterministic names that include a unique run or job identifier, and serialize workflows that must guarantee a single live key. If a run stops after B2 creates a key but before outputs or cleanup complete, rerunning the same deterministic `key-name` fails before creating a duplicate and logs the existing application key ID to revoke. The one-time secret cannot be recovered from an existing key.

By default, `create-key` requires `scope-bucket` and `valid-duration`, and only allows file-level capabilities. Use `allow-account-level-key: true`, `allow-non-expiring-key: true`, or `allow-privileged-capabilities: true` only in reviewed workflows that intentionally need those broader credentials. Accepted B2 capabilities are:

`listFiles`, `readFiles`, `shareFiles`, `writeFiles`, `deleteFiles`, `readFileLegalHolds`, `writeFileLegalHolds`, `readFileRetentions`, `writeFileRetentions`, `listKeys`, `writeKeys`, `deleteKeys`, `listBuckets`, `listAllBucketNames`, `readBuckets`, `writeBuckets`, `deleteBuckets`, `readBucketRetentions`, `writeBucketRetentions`, `readBucketEncryption`, `writeBucketEncryption`, `readBucketReplications`, `writeBucketReplications`, `readBucketNotifications`, `writeBucketNotifications`, `readBucketLogging`, `writeBucketLogging`, `bypassGovernance`.

`delete-key` refuses arbitrary IDs unless the target key matches `key-name`, matches `target-key-name-prefix`, or `allow-unsafe-key-delete: true` is set. Only use `allow-unsafe-key-delete: true` in reviewed workflows, and never source `target-application-key-id` from untrusted event context such as issue comments, pull request text, or user-controlled dispatch inputs. It refuses to delete the currently authorized application key. It treats an already-absent key as a successful no-op and honors `dry-run: true` by validating/reporting the target without deleting it, except unsafe dry-runs explicitly report that existence and metadata were not validated.

The safety lookups used by `create-key` and validated `delete-key` scan application keys in bounded pages and abort between pages on workflow cancellation. If the scan reaches the internal cap before proving uniqueness or finding the target, the action fails rather than continuing an unbounded full-account scan.

### Chain outputs

```yaml
- id: up
  uses: backblaze-labs/b2-action@v1
  with:
    action: upload
    bucket: my-bucket
    source: ./build/app.tar.gz

- run: |
    echo "Uploaded file ID: ${{ steps.up.outputs.file-id }}"
    echo "SHA-1:            ${{ steps.up.outputs.content-sha1 }}"
    echo "Bytes:            ${{ steps.up.outputs.bytes-transferred }}"
```

---

## Inputs (full reference)

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `action` | yes | | One of 16: `upload`, `download`, `sync`, `copy`, `delete`, `presign`, `list`, `hide`, `unhide`, `verify`, `retention`, `head`, `purge`, `create-key`, `list-keys`, `delete-key` |
| `application-key-id` | no\* | | B2 application key ID. Falls back to `$B2_APPLICATION_KEY_ID`. |
| `application-key` | no\* | | B2 application key. Falls back to `$B2_APPLICATION_KEY`. |
| `bucket` | file actions only | | Destination bucket name. Not required for application-key management actions. |
| `source-bucket` | copy only | `bucket` | Source bucket for cross-bucket copy. |
| `source` | command-dependent | | Local path/glob (upload/sync up); B2 file name or prefix (everything else). Prefix downloads reject keys with empty, `.`, `..`, or control-character path segments. For whole-bucket purge, omit `source` or set `/` and set `allow-bucket-purge: true`. |
| `destination` | command-dependent | | B2 file/prefix (upload/sync up/copy); local path (download/sync down/verify). Upload destinations are not normalized by the action; SDK/B2 key validation errors are surfaced rather than silently rewriting `/` characters. |
| `include` | no | | CSV of glob patterns to include (upload). |
| `exclude` | no | `.git/**` | CSV of glob patterns to exclude (upload). |
| `concurrency` | no | `4` | Parallel parts/files. Must be a positive decimal integer. |
| `part-size` | no | SDK default | Multipart part size in bytes. Must be a positive decimal integer. |
| `resume` | no | `true` | Reserved. Currently not honored; the action's streaming upload source is non-sliceable, so retries do a full re-upload. Kept in the input surface so it can light up if a `BufferSource` fallback ships. |
| `content-type` | no | `b2/x-auto` | MIME type for uploads. |
| `file-info` | no | | Upload fileInfo metadata as newline- or simple comma-separated `key=value` pairs. Use newline-separated entries when values contain commas. Keys are normalized to lowercase, may contain letters, digits, and B2-supported special characters, cannot start with `b2-`, and must fit B2 fileInfo limits. Use `cache-control`, `content-disposition`, `content-language`, or `expires` for reserved `b2-*` response headers. |
| `cache-control` | no | | Cache-Control response header to store with uploaded files. |
| `content-disposition` | no | | Content-Disposition response header to store with uploaded files. |
| `content-language` | no | | Content-Language response header to store with uploaded files. |
| `expires` | no | | Expires response header to store with uploaded files. |
| `preserve-mtime` | no | `false` | Store each uploaded file's local modification time as B2 `src_last_modified_millis`. |
| `dry-run` | no | `false` | Preview only (sync/delete/purge). |
| `allow-bucket-purge` | purge only | `false` | Permit `purge` to target the entire bucket when `source` is empty or `/`. |
| `presign-ttl` | no | `3600` | Presigned URL TTL in seconds. Must be a positive decimal integer. |
| `endpoint` | no | | Override B2 realm (staging/custom). |
| `fail-on-empty` | no | `true` | Fail if an upload glob matches zero files. |
| `sse` | no | | Server-side encryption: `B2` (SSE-B2) or `C:<base64-32-byte-key>` (SSE-C). SSE-C keys must use canonical base64 and decode to exactly 32 bytes. |
| `compare-mode` | no | `modtime` | Sync comparison: `modtime` \| `size` \| `none`. |
| `keep-mode` | no | `no-delete` | Sync deletion of orphans: `no-delete` \| `delete` \| `keep-days`. |
| `direction` | no | `auto` | Sync direction: `auto` \| `up` (local→B2) \| `down` (B2→local). |
| `max-results` | no | `1000` | `list` / `list-keys` upper bound. Must be a positive decimal integer. Truncation is reported in the step summary. |
| `expected-sha1` | no | | `verify` literal 40-character hexadecimal SHA-1 to compare against; malformed values fail the action before comparison. Non-comparable remote SHA-1 headers such as `none` or `unverified:<sha1>` publish `verified=false` outputs before failing the step. |
| `retention-mode` | no | | `retention` mode: `compliance` \| `governance` \| `none`. |
| `retention-until` | no | | `retention` ISO 8601 expiry (required when mode is compliance/governance). |
| `legal-hold` | no | | `retention` legal-hold value: `on` \| `off`. |
| `bypass-governance` | no | `false` | Allow governance-mode retention bypass for retention changes and `delete`/`purge` removals. Requires the B2 application key to include `bypassGovernance`. |
| `capabilities` | create-key only | | CSV of B2 capabilities to grant, for example `listFiles,readFiles,writeFiles`. Key-management and account-administration capabilities require `allow-privileged-capabilities: true`. |
| `key-name` | create-key / delete-key | | Human-readable application key name. Required by `create-key`; for `delete-key`, validates the target unless `target-key-name-prefix` or `allow-unsafe-key-delete` is used. |
| `scope-bucket` | create-key only | | Bucket name to scope the new key to. Omit only with `allow-account-level-key: true`. |
| `name-prefix` | create-key only | | Optional file-name prefix restriction. Requires `scope-bucket`. |
| `valid-duration` | create-key only | | Key lifetime in seconds. Must be a positive decimal integer. Omit only with `allow-non-expiring-key: true`. |
| `target-application-key-id` | delete-key only | | Application key ID to delete. |
| `target-key-name-prefix` | delete-key only | | Application key name prefix allowed for target validation. Use this or `key-name` unless `allow-unsafe-key-delete: true` is set. |
| `allow-account-level-key` | create-key only | `false` | Permit minting an account-level key without `scope-bucket`. |
| `allow-non-expiring-key` | create-key only | `false` | Permit minting a key without `valid-duration`. |
| `allow-privileged-capabilities` | create-key only | `false` | Permit key-management or account-administration capabilities such as `listKeys`, `writeKeys`, `deleteKeys`, bucket administration, or `bypassGovernance`. |
| `allow-unsafe-key-delete` | delete-key only | `false` | Permit deletion without validating target key name or prefix. Never source `target-application-key-id` from untrusted event data when enabled. |

\* Either set the input or one of the env-var fallbacks.

## Outputs (full reference)

| Output | When | Description |
| --- | --- | --- |
| `application-key-id` | create-key / delete-key | Application key ID. |
| `application-key` | create-key | Application key secret returned once by B2. Masked before the output is written, but later steps can read the plaintext output; do not map it to job, composite, or reusable-workflow outputs. |
| `key-name` | create-key / delete-key | Application key name. |
| `keys-listed` | list-keys | Count returned (capped by `max-results`). |
| `key-deleted` | delete-key | `true` when a key was deleted; `false` for dry-run or already-absent no-ops. |
| `file-id` | upload / copy / hide / retention / head; unhide if a hide marker was removed | B2 file ID. For `unhide`, this identifies the removed hide marker, not the target object. |
| `file-name` | single-file ops | B2 file name (path). |
| `content-sha1` | upload / download / head when available | SHA-1 hex. Omitted when B2 does not expose a whole-file SHA-1, including multipart objects. |
| `bytes-transferred` | upload / download / sync / copy / head | Total bytes moved. Head emits `0`. |
| `file-count` | file/object commands | Aggregate count of files matched or processed, including skipped sync entries and dry-run delete/purge matches. Not emitted by key-management actions. Prefer verb-specific count outputs when available. |
| `files-uploaded` | upload / sync up | Count. |
| `files-downloaded` | download / sync down | Count. |
| `files-deleted` | delete / purge / sync | Count. |
| `files-listed` | list / prefix presign | Count returned (capped by `max-results`). |
| `presigned-url` | presign | Time-limited download URL. Masked as a secret. This is the only structured output that carries the live presigned URL. |
| `verified` | verify | `true` / `false`. |
| `remote-sha1` | verify | Normalized comparable remote SHA-1, raw non-comparable B2 value such as `none` or `unverified:<sha1>`, or empty when B2 does not expose one. |
| `local-sha1` | verify | Local file SHA-1 (when computed from `destination`). |
| `summary-json` | every command | Complete JSON array with per-file or per-key details when the result fits within 256 KiB of UTF-8 JSON text. When the result exceeds the cap, this output is `[]` instead of changing shape or emitting a partial array. Credential-like fields are omitted by name for every command. For `presign`, entries omit live presigned URLs; for key actions, entries omit one-time key secrets, `accountId`, and deprecated `bucketId`. |
| `summary-json-truncated` | every command | `true` / `false`. Always emitted. `true` means the full manifest exceeded the supported `summary-json` size cap. |
| `summary-json-notice` | every command when truncated | Small JSON object describing why `summary-json` was truncated and where to find the bounded preview. |
| `summary-json-preview` | every command when truncated | Bounded partial JSON array with the first 100 entries that fit the cap. Do not treat it as a complete manifest. Credential-like fields are omitted by name for every command. For `presign`, entries omit live presigned URLs. |
| `retryable` | classified SDK failures | `true` only when the failed action is safe to re-run automatically. Mutating actions with ambiguous transient failures emit `false` so callers inspect B2 state first. |
| `retry-after` | classified SDK failures | Retry delay in seconds, clamped to 3600. Emitted only with `retryable=true`; network failures use a default backoff. |

`summary-json` is complete-or-empty-on-truncation: it never changes shape and never carries a silently partial array. Consumers that parse `summary-json` as an array must first branch on `summary-json-truncated`; when it is `true`, the scalar count outputs (`file-count`, `files-listed`, `files-uploaded`, and the other verb-specific counts) remain the authoritative totals and may exceed the number of entries in `summary-json-preview`. Do not use `summary-json-preview` as an authoritative manifest for security-sensitive checks; fail or fetch a complete manifest another way.

For upload entries, `fileInfo` contains SDK-returned metadata when B2 reports it; if the SDK response omits metadata, the action falls back to the canonical fileInfo submitted with the upload request.

When truncated, `summary-json-notice` contains `{ "truncated": true, "reason": string, "totalCount": number, "previewCount": number, "previewOutput": "summary-json-preview" }`.

For every command, `summary-json` and `summary-json-preview` omit fields with credential-bearing names (`url`, fields ending in `url`, fields containing `authorization`, `signature`, or `token`, and common credential names such as `applicationKey`, `secret`, `secretKey`, and `accessKey`, ignoring case, underscores, and hyphens). If a future command needs to expose a similarly named non-secret value, it must project it to an explicit safe field name before emitting the summary.

For `presign`, `summary-json` and `summary-json-preview` contain only non-secret manifest fields such as `fileName` and `expiresAt`; the dedicated `presigned-url` output is the only structured output that contains a bearer URL. In prefix mode, only the first generated URL is exposed through `presigned-url`; bulk URL fan-out through `summary-json` is intentionally unsupported because those URLs are credentials. Generate or handle additional URLs in a trusted step that treats them as secrets.

`$GITHUB_STEP_SUMMARY` per-file tables render at most the first 100 rows. When more rows exist, the summary includes a `Showing first 100 of N rows.` notice and the scalar outputs keep reporting the full source count. Status cells are escaped and rendered as inline code so object metadata cannot break the markdown table.

`retryable` and `retry-after` are emitted only on the failure path, immediately before the Action calls `core.setFailed`. To consume them, set `continue-on-error: true` on the B2 step and guard the follow-up step explicitly:

```yaml
- id: b2
  uses: backblaze-labs/b2-action@v1
  continue-on-error: true
  with:
    action: list
    bucket: ${{ vars.B2_BUCKET }}

- name: Retry after a safe transient failure
  if: steps.b2.outputs.retryable == 'true'
  run: |
    sleep "${{ steps.b2.outputs['retry-after'] || '30' }}"
    echo "retry the read-only operation here"
```

Treat `retry-after` as server-influenced input even though this Action clamps it; do not pass it to unbounded sleeps or shell code without your own policy.

---

## Other Backblaze B2 Actions on the Marketplace

If this Action doesn't fit your workflow, here are other community-maintained options on the GitHub Marketplace:

1. [`pigri/backblaze-b2-action`](https://github.com/pigri/backblaze-b2-action): syncs a directory to a B2 bucket via the `b2 sync` CLI.
2. [`yamatt/backblaze-b2-upload-action`](https://github.com/yamatt/backblaze-b2-upload-action): uploads a single file to a B2 bucket.
3. [`sksat/b2-upload-action`](https://github.com/sksat/b2-upload-action): uploads a single file to a B2 bucket.
4. [`sylwit/install-b2-cli-action`](https://github.com/sylwit/install-b2-cli-action): installs the Backblaze `b2` CLI binary on the runner.
5. [`andromidasj/install-b2-cli-action`](https://github.com/andromidasj/install-b2-cli-action): installs and authorizes the Backblaze `b2` CLI.

---

## Development & contributing

The internal architecture (dispatcher flow, source layout, conventions, CI gates) and local commands live in [DEVELOPMENT.md](./DEVELOPMENT.md). The PR process is in [CONTRIBUTING.md](./CONTRIBUTING.md); the release runbook is in [RELEASE.md](./RELEASE.md).

Security reports: see [SECURITY.md](./SECURITY.md).

## Running locally from the CLI

This is a GitHub Action, not a published CLI, but the bundle is a plain Node script you can run directly for a local smoke test. It reads the same `INPUT_*` variables Actions sets (each `action.yml` input maps to `INPUT_<NAME>`, upper-cased), and falls back to `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` for credentials:

```bash
INPUT_ACTION=list INPUT_BUCKET=my-bucket \
  B2_APPLICATION_KEY_ID=... B2_APPLICATION_KEY=... \
  node dist/index.js
```

## License

[MIT](./LICENSE).
