# Releasing `backblaze-labs/b2-action`

The single source of truth for how releases of this Action are cut, automated, and published to the GitHub Marketplace. Everything else in the repo links here.

## Model

- The Action is consumed as `uses: backblaze-labs/b2-action@v1`. There is no npm package and no CLI: `package.json` is `private: true`, `name: "b2"`.
- Releases are tag-driven. Push an annotated `vX.Y.Z` tag and [`.github/workflows/release.yml`](./.github/workflows/release.yml) runs the full gate, moves the floating major tag (`v1`, `v2`, ...) to the new commit, and cuts a GitHub Release so consumers pinned to a major continue to track the latest minor/patch.
- Pre-release tags (`vX.Y.Z-*`) are published as pre-releases and do **not** move the floating major tag. Bare `v1` / `v2` deliberately do not match the release trigger, so the workflow re-pointing them never re-runs itself.
- Versioning is semver. The first public release is `1.0.0`.

## Runbook: cut a release

As you land PRs, accumulate notes under the `## [Unreleased]` heading in [`CHANGELOG.md`](./CHANGELOG.md), grouped Keep-a-Changelog style (`### Added`, `### Changed`, `### Fixed`, `### Removed`).

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

The tag push fires the release workflow described below.

> The initial `1.0.0` could not use `pnpm version` because `package.json` already carried that version. It was tagged directly with `git tag -a v1.0.0 -m v1.0.0 && git push --follow-tags`. Use `pnpm version` from `1.0.1` onward.

To re-run a release for an existing tag, use the `workflow_dispatch` input on `release.yml`.

## What the release workflow does

[`.github/workflows/release.yml`](./.github/workflows/release.yml) runs on every three-component `vX.Y.Z` (or `vX.Y.Z-*`) tag push:

1. Checks out the tag with `fetch-depth: 0`. Sets `HUSKY=0` so hooks never run in CI.
2. Installs with `--frozen-lockfile`, then runs `lint`, `typecheck`, `test`, `build`.
3. Verifies `git diff --exit-code -- dist/` is clean: the committed bundle must match a fresh build at the tagged commit.
4. Verifies the tag equals `package.json` version, that the bundle contains the `b2-github-action/` User-Agent token, and that the bundle inlines the same version string. ncc tree-shakes the JSON import in `src/version.ts` so the token and the version appear separately in the bundle, not as one contiguous literal; checking each independently is the end-to-end "bake" gate.
5. Detects any pre-release suffix (`vX.Y.Z-*`). Pre-releases skip the floating-tag step.
6. Verifies a stable tag is the newest `vX.Y.Z` tag for its major version before any publish-side effects.
7. Moves the floating major tag (e.g. `v1`) to the release commit via the refs API. See [Floating tag automation](#floating-tag-automation) below for the token requirement; missing or unusable credentials fail before a stable GitHub Release is created or updated.
8. Creates the GitHub Release via `softprops/action-gh-release@v3` with `generate_release_notes: true`.

## One-time setup

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

For stable tags, the workflow first confirms the tag is the newest stable `vX.Y.Z` for that major version, then moves `vN` before it creates or updates the GitHub Release. A `workflow_dispatch` run for an older stable tag is rejected so the floating tag cannot be forced backward without a reviewed manual rollback process. If the secret is absent, expired, revoked, or cannot read tag refs, the job fails before the public GitHub Release / Marketplace artifact is published; the immutable `vX.Y.Z` Git tag still exists because it is what triggered the workflow. Treat that failure as a release blocker: configure the secret and rerun the release workflow, or move the floating tag by hand before publishing.

After `vN` moves, the following GitHub Release creation step can still fail because of a transient GitHub API or runner problem. In that state, `@vN` consumers may receive the new commit before the GitHub Release page exists. Rerun the same workflow for the same `vX.Y.Z` tag; the floating-tag update and GitHub Release creation are idempotent, so a rerun is the expected recovery path when `vN` is already advanced.

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
