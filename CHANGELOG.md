# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Pin every third-party GitHub Action in `.github/workflows/` to a full commit SHA (with an exact `# vX.Y.Z` comment), so a moved or compromised upstream tag cannot alter our CI or the `contents: write` release job. Dependabot keeps the pins current. ([#18](https://github.com/backblaze-labs/b2-action/issues/18))
- Run workflow security through the shared `backblaze-labs/github-actions` composite action in `.github/workflows/security.yml`, covering actionlint, third-party action pin checks, and zizmor audits without duplicating those scripts in this repo. ([#18](https://github.com/backblaze-labs/b2-action/issues/18))
- Add a dependency vulnerability gate: a CI `audit` job runs `pnpm audit --prod --audit-level high` (available locally as `pnpm run audit`), failing the build on a high or critical advisory in a production dependency. Scoped to production deps so a dev-tooling advisory cannot block an unrelated PR. ([#21](https://github.com/backblaze-labs/b2-action/issues/21))
- Add a CodeQL (SAST) workflow (`.github/workflows/codeql.yml`) that statically analyzes the TypeScript source on every PR to `main`, on push to `main`, and weekly, surfacing findings in the repo Security tab. Uses `build-mode: none` (no compile needed) and SHA-pinned `github/codeql-action`. ([#20](https://github.com/backblaze-labs/b2-action/issues/20))

### Added

- Add a weekly real-B2 large multipart smoke workflow that uploads a payload above B2's recommended part size, downloads it, checks SHA-1 integrity, and deletes the test prefix. ([#25](https://github.com/backblaze-labs/b2-action/issues/25))

### Changed

- `upload`: directory/glob uploads now consistently treat `destination` as a prefix even when the source resolves to a single file; only an explicit single-file source treats a non-trailing-slash `destination` as the exact object key.

### Documentation

- README: added a "Pinning and versioning" section recommending consumers pin `backblaze-labs/b2-action` to a commit SHA (or a signed `@vX.Y.Z` tag) rather than the mutable `@v1` floating tag, mirroring the supply-chain practice the Action applies to its own workflows.

## [1.0.1] - 2026-05-29

Release-pipeline, Marketplace metadata, and dependency hygiene. No runtime behavior changes; consumers pinning `uses: backblaze-labs/b2-action@v1` get this automatically.

### Changed

- `action.yml`: Marketplace listing name set to `Backblaze B2 Cloud Storage Action` (must be globally unique on the Marketplace; independent of the repo path `backblaze-labs/b2-action` used in `uses:`). Description trimmed to under 125 characters (Marketplace cap).
- README: tagline calls this the **official** Backblaze B2 GitHub Action; Marketplace badge points at the new listing slug `backblaze-b2-cloud-storage-action`.
- `release.yml` tag trigger restricted to three-component semver (`vX.Y.Z` and `vX.Y.Z-*`). The floating `v1` / `v2` aliases the workflow itself moves no longer match the trigger, so re-pointing them never re-runs the release.
- `release.yml` User-Agent bake gate now checks for the `b2-github-action/` token and the inlined version string independently. ncc tree-shakes the JSON import in `src/version.ts` so the two appear separately in the bundle, not as one contiguous literal.
- Bumped Dependabot devDeps: `cspell` 9 → 10, `@types/node` → 25.9.x, `vitest` and `@vitest/coverage-v8` → 4.1.7, `actions/upload-pages-artifact` v3 → v5, `actions/deploy-pages` v4 → v5.

### Fixed

- `.husky/pre-push` no longer uses `set -o pipefail`: husky sources hooks with `sh` (dash on Linux runners), where `pipefail` is an illegal option. The hook now uses `set -eu`. The release workflow also sets `HUSKY=0` so the in-CI `git push` of the floating major tag doesn't re-trigger local hooks.
- `pnpm-workspace.yaml` excludes `@backblaze-labs/*` from `minimumReleaseAge` so a freshly-published SDK release doesn't block `pnpm install --frozen-lockfile` in CI.
- The default `GITHUB_TOKEN` cannot create or move a tag whose commit contains workflow files. `release.yml` now uses a `FLOATING_TAG_TOKEN` secret (a PAT or GitHub App token with `workflows` permission) for the floating-tag step, and skips with a warning instead of failing if the secret is absent.

### Added

- SSH-signed tag support documented in [RELEASE.md](./RELEASE.md): set `git config --global tag.gpgSign true` once and `pnpm version` produces signed annotated tags.
- [RELEASE.md](./RELEASE.md) consolidates the release runbook, workflow internals, and one-time setup (signed tags, `FLOATING_TAG_TOKEN`, first Marketplace publish). Release-process documentation now lives in one place; CONTRIBUTING.md, DEVELOPMENT.md, and README.md just link there.

## [1.0.0] - 2026-05-28

Initial release. Built on [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript) `^0.1.0`.

### Added: thirteen verbs

- `upload`: single file or glob upload. Streams via fs ReadStream → Web ReadableStream so multi-GB payloads don't buffer in RAM. Multipart auto-routes via the SDK when size exceeds the recommended part size, with `concurrency`, `part-size`, `resume` controls.
- `download`: single file (by basename, exact path, or into an existing directory) or prefix-bulk (when `source` ends with `/`).
- `sync`: bi-directional mirror between a local directory and a B2 bucket prefix. `direction: auto | up | down` auto-detects from `source`. Supports `compare-mode` (modtime / size / none), `keep-mode` (no-delete / delete / keep-days), and `dry-run`.
- `copy`: server-side copy via `b2_copy_file` (small) or `b2_copy_part` (large). Same-bucket or cross-bucket via `source-bucket`. Bytes never traverse the runner.
- `delete`: single file by name, or prefix-bulk via `b2_list_file_versions` streamed through the SDK's `deleteAll`. Supports `dry-run`.
- `list`: list files under a prefix, emit JSON as a step output for downstream consumers; reports truncation against `max-results`.
- `hide`: soft-delete via hide marker (thin wrapper around `b2_hide_file`).
- `unhide`: restore a hidden file by deleting its top hide marker (wraps the SDK's `bucket.unhide()`).
- `verify`: HEAD-request the remote SHA-1 and compare to `expected-sha1` or a local file at `destination`. No body transfer. Reports `verified`, `remote-sha1`, `local-sha1` outputs.
- `presign`: time-limited download URL via `b2_get_download_authorization`. URL is masked with `core.setSecret`. Prefix mode (trailing `/`) generates one URL per file under the prefix, capped by `max-results`.
- `retention`: Object Lock retention (compliance/governance) + legal hold on a file version. Requires a fileLock-enabled bucket.
- `head`: HEAD-only metadata probe (size, sha1, contentType, fileInfo, uploadTimestamp) without transferring the body.
- `purge`: permanently delete every file version under a prefix, including hide markers and historical uploads. Differs from `delete` in intent (wipe-and-rebuild) and emits a loud warning when no prefix is specified. Supports `dry-run`.

### Added: cross-cutting

- Node 24 JavaScript action bundled with `@vercel/ncc`.
- Server-side encryption: `sse: B2` (SSE-B2) or `sse: C:<base64-32-byte-key>` (SSE-C). MD5 of the SSE-C key is computed internally with `node:crypto`.
- `$GITHUB_STEP_SUMMARY` markdown table written by every command, with per-file rows and totals.
- Credential resolution chain: action input → `B2_APPLICATION_KEY_ID` / `B2_APPLICATION_KEY` env var. The standard names used by the Backblaze `b2` CLI and the official SDK.
- Auto-masking of the application key, the resulting auth token, and any presigned URL via `core.setSecret`.
- Custom User-Agent attribution (`b2-github-action/<version>`) so Backblaze server-side logs can identify CI traffic.

### Added: quality gates

- Vitest suite (156 tests across 13 files) running against the SDK's in-memory `B2Simulator`. No real network.
- Coverage gate (`pnpm test:coverage`): 95 % statements / 85 % branches / 100 % functions / 95 % lines. Current run: **100 % / 100 % / 100 % / 100 %**.
- CI workflow with six jobs: `test` (Ubuntu / macOS / Windows matrix), `lint` (Biome `--error-on-warnings`), `coverage`, `build-and-check-dist` (with a 4 MiB bundle-size budget), `actionlint`, and `self-smoke` (offline bundle invocation).
- Tag-driven release workflow (`.github/workflows/release.yml`) that runs the full gate, cuts a GitHub Release, and moves the floating major tag (`v1`, `v2`, …) to track the latest minor/patch.
- Dependabot config for weekly npm + github-actions updates.
- Twelve example workflows under `.github/workflows/example-*.yml` that double as live integration tests against a real B2 test bucket. See [.github/workflows/README.md](.github/workflows/README.md) for the catalogue. There is no separate `integration.yml`; the examples *are* the integration suite.

### Added: community files

- `SECURITY.md` with redaction guidance and a 30-day coordinated-disclosure timeline.
- `CONTRIBUTING.md` documenting the "add a new verb" pattern, style conventions, and release process.
- `CODEOWNERS` defaulting to `@backblaze-labs/maintainers`, with elevated ownership of `release.yml`, `ci.yml`, `dist/`, `action.yml`, and `SECURITY.md`.
- `.editorconfig` mirroring Biome's settings for contributors whose IDE doesn't have Biome wired up.
- `.github/FUNDING.yml` pointing at the Backblaze B2 free-tier signup as the "support the project" path.
- Issue templates: `bug_report.yml`, `feature_request.yml`, plus `config.yml` directing security reports + B2-service questions + SDK bugs to the right places.
- Pull request template with a checklist (build, dist, tests, README, CHANGELOG).
- Status + Quality + Tech-stack + Community badge rows in the README (CI, Release, Marketplace, Latest release, License, Tests, Coverage, Bundle size, Verbs, Examples, TypeScript, Node 24, Biome, SDK attribution, No-Docker, PRs welcome, Open issues, Stars, Backblaze).
- Mermaid architecture diagram in the README "How it works" section.

### Added: operational

- `daily-smoke.yml` workflow: runs the most-used verbs end-to-end against a real B2 test bucket once a day. Catches B2 API drift or SDK regressions before user-reported issues.

### Deferred (not planned for v1.x)

- Bucket-level admin verbs (`create-bucket`, `update-bucket-lifecycle`, `set-notification-rules`, replication config). Their inputs are arrays-of-objects that don't fit the flat `with:` input shape; an admin-focused Action or Terraform provider is a better home.

### Inputs

`action`, `application-key-id`, `application-key`, `bucket`, `source-bucket`, `source`, `destination`, `include`, `exclude`, `concurrency`, `part-size`, `resume`, `content-type`, `dry-run`, `presign-ttl`, `endpoint`, `fail-on-empty`, `sse`, `compare-mode`, `keep-mode`, `direction`, `max-results`, `expected-sha1`, `retention-mode`, `retention-until`, `legal-hold`, `bypass-governance`.

### Outputs

`file-id`, `file-name`, `content-sha1`, `bytes-transferred`, `files-uploaded`, `files-downloaded`, `files-deleted`, `files-listed`, `presigned-url`, `verified`, `remote-sha1`, `local-sha1`, `summary-json`.

[Unreleased]: https://github.com/backblaze-labs/b2-action/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/backblaze-labs/b2-action/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/backblaze-labs/b2-action/releases/tag/v1.0.0
