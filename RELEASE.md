# Releasing `backblaze-labs/b2-action`

The single source of truth for how releases of this Action are cut, automated, and published to the GitHub Marketplace. Everything else in the repo links here.

## Model

- The Action is consumed as `uses: backblaze-labs/b2-action@v1`. There is no npm package and no CLI: `package.json` is `private: true`, `name: "b2"`.
- Releases are tag-driven. Push an annotated `vX.Y.Z` tag and [`.github/workflows/release.yml`](./.github/workflows/release.yml) runs the full gate, stages and verifies release assets, moves the floating major tag (`v1`, `v2`, ...) for stable releases, and publishes a GitHub Release so consumers pinned to a major continue to track the latest minor/patch.
- Pre-release tags (`vX.Y.Z-<suffix>`, such as `vX.Y.Z-rc.N`) are published as pre-releases and do **not** move the floating major tag. Bare `v1` / `v2` deliberately do not match the release trigger, so the workflow re-pointing them never re-runs itself.
- Release tags must be protected by the repo ruleset described below so only trusted release maintainers can create or move `vX.Y.Z` tags, and only to commits that have landed on protected `main`.
- Versioning is semver. The first public release is `1.0.0`.

## Runbook: cut a release

As you land PRs, accumulate notes under the `## [Unreleased]` heading in [`CHANGELOG.md`](./CHANGELOG.md), grouped Keep-a-Changelog style (`### Added`, `### Changed`, `### Fixed`, `### Removed`).

### Pre-release checklist

The release workflow gates code and provenance, but a few coherence checks are not automated. Run through this on a clean, up-to-date `main` before `pnpm version`:

- [ ] **CHANGELOG is complete.** Review `git log <last-tag>..HEAD` (or the merged-PR list for the milestone) and confirm every notable change has an `[Unreleased]` entry: new/changed `action.yml` inputs or outputs, behavior changes, deprecations, and dependency bumps (especially `@backblaze-labs/b2-sdk`).
- [ ] **Docs match code.** `pnpm docs:check-action-yml` passes (README inputs/outputs synced with `action.yml`), and the verb count, workflow inventory, and coverage claim in `README.md` / `DEVELOPMENT.md` / `CONTRIBUTING.md` still reflect reality. Prefer gate-backed wording (for example the `95+%` coverage badge) over hard-coded counts that silently drift.
- [ ] **All gates green locally.** `pnpm all` (lint, release-provenance, typecheck, test, build, spellcheck), plus `pnpm test:coverage`, `pnpm docs:lint`, `pnpm docs:links`, and `pnpm audit`.
- [ ] **`dist/` is fresh.** `pnpm verify-dist` is clean (rebuild produces no diff).
- [ ] **No stale version references** in prose or examples.

Automating the CHANGELOG-completeness check (a PR-time gate requiring a `CHANGELOG.md` entry) is tracked separately; until then this checklist is the backstop.

From a clean, up-to-date `main`:

```bash
pnpm version <patch|minor|major>   # or: pnpm version X.Y.Z
git push --follow-tags
```

`pnpm version` runs the lifecycle scripts defined in `package.json`:

```jsonc
"preversion": "pnpm lint && pnpm typecheck && pnpm test",
"version":    "node scripts/cut-changelog.mjs && pnpm build && git add CHANGELOG.md dist"
```

That is:

1. **`preversion`** gates the release (lint, typecheck, tests).
2. **`pnpm version`** bumps `package.json` `version`.
3. **`version`** dates the `[Unreleased]` section via [`scripts/cut-changelog.mjs`](./scripts/cut-changelog.mjs), rebuilds `dist/` so the new version bakes into the bundle and User-Agent, and stages both into the version commit.
4. **`pnpm version`** commits everything and creates the annotated `vX.Y.Z` tag (SSH-signed if `tag.gpgSign` is set; see [Signed tags](#signed-tags)).
5. **`git push --follow-tags`** pushes the commit plus the new annotated tag. `--follow-tags` pushes only annotated tags, so a stale local `vN` cannot clobber the remote floating tag.

The tag push fires the release workflow described below. GitHub executes tag-triggered workflows from the tagged commit, so the protected-tag ruleset is part of the release security boundary; do not publish releases until that ruleset is active.

> The initial `1.0.0` could not use `pnpm version` because `package.json` already carried that version. It was tagged directly with `git tag -a v1.0.0 -m v1.0.0 && git push --follow-tags`. Use `pnpm version` from `1.0.1` onward.

To re-run a release for an existing tag, dispatch `release.yml` from the tag ref itself so any attestation remains anchored to `refs/tags/<tag>`:

```bash
TAG=vX.Y.Z
gh workflow run release.yml --repo backblaze-labs/b2-action --ref "$TAG" -f tag="$TAG"
```

## What the release workflow does

[`.github/workflows/release.yml`](./.github/workflows/release.yml) runs on every three-component `vX.Y.Z` (or `vX.Y.Z-*`) tag push:

1. Resolves the release ref once as an existing semver tag under `refs/tags/`, rejects branch or ambiguous manual inputs, requires the tagged commit to be reachable from `origin/main`, checks out the resolved commit SHA, and exports that SHA for downstream jobs.
2. Installs with `--frozen-lockfile`, then runs `lint`, `typecheck`, `test`, `build`.
3. Verifies `git diff --exit-code -- dist/` is clean: the committed bundle must match a fresh build at the tagged commit.
4. Verifies the tag equals `package.json` version, that the bundle contains the `b2-github-action/` User-Agent token, and that the bundle inlines the same version string. ncc tree-shakes the JSON import in `src/version.ts` so the token and the version appear separately in the bundle, not as one contiguous literal; checking each independently is the end-to-end "bake" gate.
5. Runs an isolated attestation job with only `contents: read`, `id-token: write`, and `attestations: write`. That job checks out the validated SHA, fails if `refs/tags/<tag>` moved, and creates a GitHub Artifact Attestation for `dist/index.js`.
6. Runs a separate publish job without OIDC or attestation write permissions. It keeps `attestations: read` only so `gh attestation verify` can validate the staged asset. The job checks out the same validated SHA, fails if the tag moved, generates a SHA-256 checksum for `dist/index.js`, creates a draft release when needed, uploads both `index.js` and `index.js.sha256`, downloads the staged assets, and verifies their hash and attestation.
7. Leaves already-published release assets and notes untouched on rerun. GitHub-generated notes are requested only when creating the initial draft release. If existing assets are missing or do not match the validated tag bytes, the rerun fails instead of deleting or replacing them.
8. For stable tags, verifies the tag is the newest `vX.Y.Z` tag for its major version and moves the floating major tag (e.g. `v1`) to the release commit via the refs API before the draft is published. See [Floating tag automation](#floating-tag-automation) below for the token requirement; missing or unusable credentials fail before publication. Pre-releases skip the floating-tag step.
9. Publishes the verified draft release after the floating-tag gate succeeds.

The attestation is a signed statement that the release workflow handled the `dist/index.js` bytes from the validated tag. The reproducible-build guarantee still comes from the validation gate that rebuilds `dist/` from source and fails if the committed bundle differs.

The release asset upload is intentionally fail-fast. If `dist/index.js` or `dist/index.js.sha256` is missing, the job fails before publishing the GitHub Release. If a staged upload, post-upload verification, or floating-tag update fails, keep the release as a draft, fix the workflow, token, or tag contents, and rerun from the exact tag ref with the `workflow_dispatch` command above.

## Verifying release provenance

Every release created after this change includes an `index.js` asset that is byte-for-byte the committed `dist/index.js` bundle at the release tag, plus a GitHub Artifact Attestation signed by the release workflow. The attestation is the authoritative tamper/provenance check:

Prerequisites: authenticate with `gh auth login`, and use a recent GitHub CLI whose `gh attestation verify --help` output includes both `--signer-workflow` and `--source-ref` (the workflow is tested with GitHub CLI 2.91.0).

```bash
TAG=vX.Y.Z
DIR=/tmp/b2-action-release
rm -rf "$DIR"
mkdir -p "$DIR"

gh release download "$TAG" \
  --repo backblaze-labs/b2-action \
  --pattern 'index.js*' \
  --dir "$DIR"

gh attestation verify "$DIR/index.js" \
  --repo backblaze-labs/b2-action \
  --signer-workflow backblaze-labs/b2-action/.github/workflows/release.yml \
  --source-ref "refs/tags/$TAG"
```

The adjacent checksum is for download corruption diagnostics only; anyone who can maliciously edit release assets can replace both the bundle and checksum. To check it on Linux, run `(cd "$DIR" && sha256sum -c index.js.sha256)`. On macOS, run `(cd "$DIR" && shasum -a 256 -c index.js.sha256)`.

Use the exact `vX.Y.Z` release tag when verifying. The floating `v1` tag is intentionally mutable and should not be used as the verification ref.

This provenance check covers the downloadable `index.js` release asset. It does **not** verify the code executed by `uses: backblaze-labs/b2-action@v1`, because Actions runners execute `dist/index.js` from the git tree at the resolved ref and do not download release assets. Consumers who need integrity for executed workflow code should pin `uses:` to an exact commit SHA, or at least to an immutable `vX.Y.Z` tag, instead of the mutable `v1` tag.

## One-time setup

### Protected release tags

GitHub runs a tag-triggered workflow from the tagged commit, including that commit's copy of `.github/workflows/release.yml`. Protect the release tag namespace before enabling attestations so an unapproved commit cannot supply its own privileged release workflow:

1. In **Settings → Rules → Rulesets**, create an active repository ruleset targeting tags matching `v*.*.*`.
2. Restrict create, update, force-push, and delete permissions for those tags to trusted release maintainers or a dedicated release GitHub App.
3. Require release tags to point at commits that have landed on protected `main`. The workflow also checks this with `git merge-base --is-ancestor`, but the ruleset is the control that prevents an untrusted tag from choosing a different workflow file.
4. Keep the floating `vN` tags out of this ruleset or allow the `FLOATING_TAG_TOKEN` actor to update them, because the release workflow moves those server-side.

### Signed tags

Tags should be signed so they show "Verified" on GitHub. This repo already SSH-signs commits; enable tag signing too (it reuses the same key):

```bash
git config --global tag.gpgSign true   # or --local for just this repo
```

The annotated tag `pnpm version` creates will then be signed. Register the SSH public key on GitHub as a **Signing Key** (Settings → SSH and GPG keys → New SSH key → Key type: *Signing Key*). If your commits already show "Verified", it is.

Only the immutable `vX.Y.Z` tags carry signatures. The floating `vN` is moved server-side by the workflow and therefore reads "Unverified" by design: pin an exact `vX.Y.Z` when verification matters.

Re-sign an older unsigned tag in place if needed:

```bash
git tag -fs vX.Y.Z vX.Y.Z^{} -m vX.Y.Z
git push origin vX.Y.Z --force
```

### Floating tag automation

The default `GITHUB_TOKEN` **cannot** create or move a tag whose commit contains workflow files (anything under `.github/workflows/`). Both `git push` and the refs API reject it, and the required `workflows` permission cannot be granted to `GITHUB_TOKEN`. The normal stable-release path therefore requires a `FLOATING_TAG_TOKEN` secret before the GitHub Release is published; the only exception is the documented `workflow_dispatch` emergency path after manual tag handling.

Use one of these credential paths:

- **Fine-grained PAT** (accepted control): repo `backblaze-labs/b2-action`, permissions **Contents: Read and write** + **Workflows: Read and write**. Rotate it at least every 90 days, after maintainer access changes, and after any suspected exposure.
- **GitHub App** token via `actions/create-github-app-token` is preferred once available because it avoids a long-lived secret.
- **Classic PAT** is not part of the normal release posture; use one only as a temporary emergency bridge and rotate it immediately afterward.

Store it as a repo secret:

```bash
gh secret set FLOATING_TAG_TOKEN --repo backblaze-labs/b2-action
```

For stable tags, the workflow first confirms the tag is the newest stable `vX.Y.Z` for that major version, stages and verifies release assets on a draft release, then moves `vN` before it publishes the GitHub Release. A `workflow_dispatch` run for an older stable tag is rejected so the floating tag cannot be forced backward without a reviewed manual rollback process. If the secret is absent, expired, revoked, or cannot read tag refs, the job fails before the public GitHub Release / Marketplace artifact is published; the immutable `vX.Y.Z` Git tag still exists because it is what triggered the workflow, and a draft release may exist with verified assets. Treat that failure as a release blocker: configure the secret and rerun the release workflow, or move the floating tag by hand before publishing.

After `vN` moves, the final publish step can still fail because of a transient GitHub API or runner problem. In that state, `@vN` consumers may receive the new commit before the GitHub Release page exists. Rerun the same workflow for the same `vX.Y.Z` tag; the floating-tag update and GitHub Release publish are idempotent, so a rerun is the expected recovery path when `vN` is already advanced.

Manual fallback, replacing `vN` with the major tag such as `v1` and `vX.Y.Z` with the exact release tag:

```bash
git fetch origin --tags
git tag -f vN vX.Y.Z^{commit}
git push origin refs/tags/vN --force
```

If the credential is temporarily unavailable and the floating tag has been moved manually, rerun the workflow with `workflow_dispatch`, the same `tag`, `skip-floating-tag: true`, and a short `skip-floating-tag-justification`. That emergency override publishes the GitHub Release without exercising `FLOATING_TAG_TOKEN`, records the justification in the workflow log, and emits a warning that `@vN` was not moved by automation. Do not use it until the manual tag move is complete or the release manager has explicitly accepted that `@vN` consumers will remain on the previous release until follow-up.

### First Marketplace publish

There is no API for this; it is a one-time manual step. `action.yml` already carries the required `name`, `description` (under 125 chars), and `branding`.

1. On the GitHub Release page, tick **Publish this Action to the GitHub Marketplace**.
2. Pick categories: **Utilities** (primary), **Deployment** (secondary).
3. Accept the **Marketplace Developer Agreement**.

The listing lives at `github.com/marketplace/actions/backblaze-b2-cloud-storage-action`. After this first publish, every tagged release appears on the Marketplace automatically through the GitHub Release the workflow creates.

## Notes

- **Marketplace name uniqueness.** `name:` in `action.yml` must be globally unique across the Marketplace (it is the listing title and URL slug). Independent of the repo path `backblaze-labs/b2-action`, which is what `uses:` references.
- **`minimumReleaseAge` and first-party deps.** [`pnpm-workspace.yaml`](./pnpm-workspace.yaml) excludes `@backblaze-labs/*` from `minimumReleaseAge` so a freshly-published SDK release does not block `pnpm install --frozen-lockfile` in CI.
- **CHANGELOG link references.** The `[Unreleased]` and `[X.Y.Z]` link references at the bottom of `CHANGELOG.md` are maintained alongside each release. `scripts/cut-changelog.mjs` updates them during `pnpm version`.
