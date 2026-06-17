# Workflows

This folder contains:

- **`ci.yml`**: runs on every PR: typecheck, lint, vitest (Ubuntu / macOS / Windows), coverage gate, build, `dist/` freshness, bundle-size budget, offline self-smoke.
- **`security.yml`**: runs the shared GitHub Actions security composite action against every workflow: actionlint, third-party action pin checks, and zizmor audits.
- **`codeql.yml`**: CodeQL (SAST) static analysis of the TypeScript source. Runs on PRs to `main`, on push to `main`, and weekly; findings surface in the repo Security tab.
- **`release.yml`**: fires on three-component `vX.Y.Z` tags (a bare `v1` does **not** trigger it): full gate + GitHub Release + floats the major-version tag (`v1`, `v2`, …).
- **`daily-smoke.yml`**: 03:13 UTC cron: real-B2 end-to-end smoke against the test bucket.
- **`large-multipart-smoke.yml`**: weekly real-B2 multipart upload + download SHA-1 integrity check for a payload above B2's recommended part size.
- **`example-*.yml`**: twelve **example workflows that are also the integration test suite**. See the table below.

## Example workflows (= integration test suite)

Every `example-*.yml` is two things at once: a copy-paste-runnable snippet you can drop into your own repo (with secrets swapped in), and a live integration test that runs against this project's Backblaze test bucket. There is no separate `integration.yml`; these workflows *are* the integration suite.

| Workflow | Demonstrates | Verb(s) |
| --- | --- | --- |
| [example-cache-artifacts.yml](./example-cache-artifacts.yml) | Save and restore a build cache between jobs | `upload`, `download` |
| [example-deploy-site.yml](./example-deploy-site.yml) | Sync a built site to B2 (replacing `b2 sync`) | `sync`, `list` |
| [example-share-build-artifact.yml](./example-share-build-artifact.yml) | Upload a PR build and post a presigned download URL as a comment | `upload`, `presign` |
| [example-promote-release.yml](./example-promote-release.yml) | Server-side copy a staging artifact to a release path | `copy` |
| [example-scheduled-backup.yml](./example-scheduled-backup.yml) | Daily cron upload with SSE-B2 + Object Lock retention | `upload`, `retention` |
| [example-verify-artifacts.yml](./example-verify-artifacts.yml) | Verify remote-vs-local SHA-1 without downloading | `verify` |
| [example-inventory-and-cleanup.yml](./example-inventory-and-cleanup.yml) | List a prefix as JSON, then delete with dry-run preview | `list`, `delete`, `sync` |
| [example-cross-bucket-replicate.yml](./example-cross-bucket-replicate.yml) | Server-side copy between two buckets | `copy` |
| [example-hide-unhide.yml](./example-hide-unhide.yml) | Soft-delete a file with restore capability | `hide`, `unhide` |
| [example-sse-encryption.yml](./example-sse-encryption.yml) | Round-trip with SSE-B2 and SSE-C | `upload`, `download`, `sse` |
| [example-head.yml](./example-head.yml) | Probe remote object metadata (size, sha1, contentType, fileInfo) without a body transfer | `head` |
| [example-purge.yml](./example-purge.yml) | Permanent wipe of every file version under a prefix, including hide markers and history | `purge` |

All are gated on `github.event.pull_request.head.repo.fork == false` so forks (which can't access repo secrets) skip silently. Maintainers can also dispatch each one manually from the Actions UI via `workflow_dispatch`.

## How to use an example in your own repo

Copy any `example-*.yml` into your own `.github/workflows/`, then:

1. Replace `uses: ./` with `uses: backblaze-labs/b2-action@v1` (or whichever ref you pin to).
2. Replace `${{ secrets.B2_TEST_BUCKET }}` etc. with your own bucket secret names.
3. Adjust the `on:` triggers, paths, and cleanup behavior to match your workflow.

Nothing else in the file should need to change: every input the action accepts is documented in the [top-level README](../../README.md). For the test-bucket setup expected by these workflows (bucket name, capabilities, lifecycle rules), see [DEVELOPMENT.md → Test bucket setup](../../DEVELOPMENT.md#test-bucket-setup).
