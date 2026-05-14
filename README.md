# Backblaze B2 GitHub Action

[![CI](https://github.com/backblaze-labs/b2-action/actions/workflows/ci.yml/badge.svg)](https://github.com/backblaze-labs/b2-action/actions/workflows/ci.yml)
[![Release](https://github.com/backblaze-labs/b2-action/actions/workflows/release.yml/badge.svg)](https://github.com/backblaze-labs/b2-action/actions/workflows/release.yml)
[![Marketplace](https://img.shields.io/github/v/release/backblaze-labs/b2-action?label=marketplace&color=red&logo=githubactions&logoColor=white)](https://github.com/marketplace/actions/backblaze-b2)
[![Latest release](https://img.shields.io/github/v/release/backblaze-labs/b2-action?display_name=tag&sort=semver&color=blue)](https://github.com/backblaze-labs/b2-action/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![Coverage](https://img.shields.io/badge/coverage-97%25-brightgreen.svg)](./vitest.config.ts)

The Backblaze B2 GitHub Action. TypeScript-native, built on the official [`@backblaze/b2-sdk`](https://github.com/backblaze/b2-sdk-typescript). Thirteen verbs covering every B2 operation a CI workflow needs.

- **Node 24 action.** No Docker. Sub-second cold start.
- **Thirteen verbs.** `upload`, `download`, `sync`, `copy`, `delete`, `list`, `hide`, `unhide`, `verify`, `presign`, `retention`, `head`, `purge`: pick via the `action` input.
- **Resumable multipart uploads** for any file size; streaming I/O so multi-GB payloads don't buffer in RAM.
- **Server-side everything.** `copy` (same-bucket or cross-bucket) and `delete` operations stay server-side; bytes never traverse the runner.
- **Server-side encryption.** SSE-B2 (managed) and SSE-C (customer key, base64).
- **Object Lock.** Governance/compliance retention + legal hold via the `retention` verb.
- **Bi-directional sync.** Local → B2 *and* B2 → local, with auto-detect.
- **Structured outputs.** `file-id`, `content-sha1`, `bytes-transferred`, `files-listed`, `presigned-url`, `verified`, `summary-json`, more.
- **Step-summary tables** rendered on every run via `$GITHUB_STEP_SUMMARY`.
- **Secret-safe.** App keys, auth tokens, and presigned URLs are auto-masked with `::add-mask::`.

> **Live test suite = the examples.** Every workflow under [.github/workflows/example-*.yml](./.github/workflows/README.md) is both a copy-paste-runnable example and an integration test that runs on every PR.

## Table of contents

- [Backblaze B2 GitHub Action](#backblaze-b2-github-action)
  - [Table of contents](#table-of-contents)
  - [Quick start](#quick-start)
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
    - [Chain outputs](#chain-outputs)
  - [Inputs (full reference)](#inputs-full-reference)
  - [Outputs (full reference)](#outputs-full-reference)
  - [Other Backblaze B2 Actions on the Marketplace](#other-backblaze-b2-actions-on-the-marketplace)
  - [Development \& contributing](#development--contributing)
  - [License](#license)

---

## Quick start

```yaml
- uses: backblaze-labs/b2-action@v0
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

## Verbs

| Verb | What it does | Required inputs |
| --- | --- | --- |
| `upload` | Single-file or glob upload, with streaming + multipart-resume. | `source`, `bucket` |
| `download` | Single-file or prefix-bulk download. | `source`, `bucket` |
| `sync` | Mirror a local directory ↔ a B2 prefix. Direction auto-detected. | `source`, `destination`, `bucket` |
| `copy` | Server-side copy. Same bucket by default; cross-bucket with `source-bucket`. | `source`, `destination`, `bucket` |
| `delete` | Single file by name, or prefix-bulk via `b2_list_file_versions`. Supports `dry-run`. | `source`, `bucket` |
| `list` | List files under a prefix; emits JSON for downstream steps. | `bucket` (and usually `source`) |
| `hide` | Soft-delete via hide marker. Underlying data preserved until lifecycle. | `source`, `bucket` |
| `unhide` | Restore a hidden file by deleting its top hide marker. | `source`, `bucket` |
| `verify` | HEAD-request the remote SHA-1 and compare to `expected-sha1` or `destination` (local file). No body transfer. | `source`, `bucket`, plus one of `expected-sha1` / `destination` |
| `presign` | Time-limited download URL via `b2_get_download_authorization`. URL is masked. Prefix mode returns one URL per file. | `source`, `bucket` |
| `retention` | Apply Object Lock retention + legal hold to a file. | `source`, `bucket`, plus `retention-mode` and/or `legal-hold` |
| `head` | Fetch object metadata (size, sha1, contentType, fileInfo) via HEAD. No body transfer. | `source`, `bucket` |
| `purge` | Permanently delete every file version under a prefix, including hide markers and history. Supports `dry-run`. | `source`, `bucket` |

---

## Worked examples

### Upload a single file

```yaml
- uses: backblaze-labs/b2-action@v0
  with:
    action: upload
    application-key-id: ${{ secrets.B2_APPLICATION_KEY_ID }}
    application-key: ${{ secrets.B2_APPLICATION_KEY }}
    bucket: my-bucket
    source: ./build/app.tar.gz
    destination: releases/${{ github.ref_name }}/app.tar.gz
```

### Upload a directory with globs

```yaml
- uses: backblaze-labs/b2-action@v0
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
- uses: backblaze-labs/b2-action@v0
  with:
    action: download
    bucket: my-bucket
    source: cache/node_modules.tar
    destination: ./node_modules.tar

# Prefix (note the trailing slash)
- uses: backblaze-labs/b2-action@v0
  with:
    action: download
    bucket: my-bucket
    source: releases/v1.2.3/
    destination: ./downloads
```

### Sync (both directions)

```yaml
# Auto: local-dir source → upload sync. Remote prefix → download sync.
- uses: backblaze-labs/b2-action@v0
  with:
    action: sync
    bucket: my-bucket
    source: ./public
    destination: site
    compare-mode: modtime
    keep-mode: delete   # remove remote files not present locally

# Force B2 → local (cache restore)
- uses: backblaze-labs/b2-action@v0
  with:
    action: sync
    bucket: my-bucket
    source: caches/${{ runner.os }}
    destination: ./.cache
    direction: down
```

### Server-side copy (same-bucket or cross-bucket)

```yaml
- uses: backblaze-labs/b2-action@v0
  with:
    action: copy
    bucket: my-bucket
    source: releases/v1.2.3/app.tar.gz
    destination: releases/latest/app.tar.gz

# Cross-bucket: promote staging → prod
- uses: backblaze-labs/b2-action@v0
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
  uses: backblaze-labs/b2-action@v0
  with:
    action: list
    bucket: my-bucket
    source: tmp/
    max-results: 5000

- uses: backblaze-labs/b2-action@v0
  with:
    action: delete
    bucket: my-bucket
    source: tmp/
    dry-run: true
```

### Hide / unhide

```yaml
- uses: backblaze-labs/b2-action@v0
  with: { action: hide, bucket: my-bucket, source: legacy/old.tar.gz }

- uses: backblaze-labs/b2-action@v0
  with: { action: unhide, bucket: my-bucket, source: legacy/old.tar.gz }
```

### Verify SHA-1 without downloading

```yaml
- uses: backblaze-labs/b2-action@v0
  with:
    action: verify
    bucket: my-bucket
    source: releases/v1.2.3/app.tar.gz
    destination: ./app.tar.gz          # compare to local file
    # OR pin to a known-good literal from your release manifest:
    # expected-sha1: 3b1d2e8c9...
```

### Presign a download URL

```yaml
- id: link
  uses: backblaze-labs/b2-action@v0
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
- uses: backblaze-labs/b2-action@v0
  with: { action: upload, bucket: my-bucket, source: ./private.tar.gz, destination: private.tar.gz, sse: B2 }

# SSE-C (customer-provided 256-bit key, base64)
- uses: backblaze-labs/b2-action@v0
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

That outputs ~44 characters (e.g. `JXqRk7TZUyDhPmlAv9pn0WzgQGkBNyfwHJtoMSCRXNc=`). Paste the value into a GitHub repository secret (`Settings → Secrets and variables → Actions`): convention is `B2_SSE_C_KEY_B64`.

A few things to know before you commit to SSE-C:

- **You own the key, Backblaze does not.** B2 never stores it. **Lose the key, lose the data**: no recovery.
- **The same key must be supplied at download time** as was used at upload. The action's `download` verb takes the same `sse: C:<key>` input.
- **Rotating the key invalidates any existing SSE-C objects** encrypted with the old value. You'd need to download-then-reupload everything with the new key.
- **The action auto-masks the key** in workflow logs via `::add-mask::`, but that masking does not survive copy-paste. Keep secrets out of bug reports.

If you don't need customer-managed keys, **`sse: B2`** (SSE-B2, B2-managed) is the simpler choice and has zero key-loss risk.

### Object Lock retention + legal hold

```yaml
- uses: backblaze-labs/b2-action@v0
  with:
    action: retention
    bucket: my-locked-bucket
    source: audits/2026-q1.tar.gz
    retention-mode: compliance
    retention-until: '2031-04-01T00:00:00Z'
    legal-hold: 'on'
```

### Chain outputs

```yaml
- id: up
  uses: backblaze-labs/b2-action@v0
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
| `action` | yes | | One of 13: `upload`, `download`, `sync`, `copy`, `delete`, `presign`, `list`, `hide`, `unhide`, `verify`, `retention`, `head`, `purge` |
| `application-key-id` | no\* | | B2 application key ID. Falls back to `$B2_APPLICATION_KEY_ID`. |
| `application-key` | no\* | | B2 application key. Falls back to `$B2_APPLICATION_KEY`. |
| `bucket` | yes | | Destination bucket name. |
| `source-bucket` | copy only | `bucket` | Source bucket for cross-bucket copy. |
| `source` | command-dependent | | Local path/glob (upload/sync up); B2 file name or prefix (everything else). |
| `destination` | command-dependent | | B2 file/prefix (upload/sync up/copy); local path (download/sync down/verify). |
| `include` | no | | CSV of glob patterns to include (upload). |
| `exclude` | no | `.git/**` | CSV of glob patterns to exclude (upload). |
| `concurrency` | no | `4` | Parallel parts/files. |
| `part-size` | no | SDK default | Multipart part size in bytes. |
| `resume` | no | `true` | Resume an in-progress large-file upload. |
| `content-type` | no | `b2/x-auto` | MIME type for uploads. |
| `dry-run` | no | `false` | Preview only (sync/delete). |
| `presign-ttl` | no | `3600` | Presigned URL TTL in seconds. |
| `endpoint` | no | | Override B2 realm (staging/custom). |
| `fail-on-empty` | no | `true` | Fail if an upload glob matches zero files. |
| `sse` | no | | Server-side encryption: `B2` (SSE-B2) or `C:<base64-32-byte-key>` (SSE-C). |
| `compare-mode` | no | `modtime` | Sync comparison: `modtime` \| `size` \| `none`. |
| `keep-mode` | no | `no-delete` | Sync deletion of orphans: `no-delete` \| `delete` \| `keep-days`. |
| `direction` | no | `auto` | Sync direction: `auto` \| `up` (local→B2) \| `down` (B2→local). |
| `max-results` | no | `1000` | `list` upper bound. Truncation is reported in the step summary. |
| `expected-sha1` | no | | `verify` literal SHA-1 to compare against. |
| `retention-mode` | no | | `retention` mode: `compliance` \| `governance` \| `none`. |
| `retention-until` | no | | `retention` ISO 8601 expiry (required when mode is compliance/governance). |
| `legal-hold` | no | | `retention` legal-hold value: `on` \| `off`. |
| `bypass-governance` | no | `false` | Allow shortening a governance retention (requires the capability). |

\* Either set the input or one of the env-var fallbacks.

## Outputs (full reference)

| Output | When | Description |
| --- | --- | --- |
| `file-id` | upload / copy / hide / retention | B2 file ID. |
| `file-name` | single-file ops | B2 file name (path). |
| `content-sha1` | upload (small) / download | SHA-1 hex. |
| `bytes-transferred` | upload / download / sync / copy | Total bytes moved. |
| `files-uploaded` | upload / sync up | Count. |
| `files-downloaded` | download / sync down | Count. |
| `files-deleted` | delete / sync | Count. |
| `files-listed` | list | Count returned (capped by `max-results`). |
| `presigned-url` | presign | Time-limited download URL. Masked as a secret. |
| `verified` | verify | `true` / `false`. |
| `remote-sha1` | verify | The remote object's SHA-1. |
| `local-sha1` | verify | Local file SHA-1 (when computed from `destination`). |
| `summary-json` | every command | JSON array with per-file details. |

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

The internal architecture (dispatcher flow, source layout, conventions, CI gates) and local commands live in [DEVELOPMENT.md](./DEVELOPMENT.md). The PR / release process is in [CONTRIBUTING.md](./CONTRIBUTING.md).

Security reports: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE).
