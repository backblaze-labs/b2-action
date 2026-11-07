# AGENTS.md

This is the map for anyone (human or AI assistant) working on `backblaze-labs/b2-action`,
the Backblaze B2 GitHub Action. **Humans steer; agents execute.** Read this file first, then
follow the pointers into the source of record. It is deliberately short: a table of contents,
not a manual. Deep detail lives in the linked files, not here.

The Action is a thin dispatcher over [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript):
it parses `INPUT_*` env vars, builds a `B2Client`, dispatches to one command per verb, and maps
the result onto step outputs and the run summary. The SDK owns every B2 wire-protocol concern.

## Repository map

| Path | What it is | Read it when |
| --- | --- | --- |
| [README.md](README.md) | User-facing usage: verbs, inputs, outputs, worked examples | Using the Action, or changing its public surface |
| [action.yml](action.yml) | Marketplace manifest and the **source of truth** for inputs/outputs | Adding or changing any input or output |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Layers, allowed dependency edges, and boundary invariants | Adding code or a verb; deciding where logic belongs |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Local commands, CI gates, test-bucket setup, tooling runbooks | Building, testing, or running any gate locally |
| [CONTRIBUTING.md](CONTRIBUTING.md) | PR flow and the step-by-step for adding a verb | Opening a change |
| [RELEASE.md](RELEASE.md) | Release runbook and provenance verification | Cutting a release |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting and redaction guidance | Handling a security concern |
| [CHANGELOG.md](CHANGELOG.md) | Keep a Changelog history; add user-visible changes under `[Unreleased]` | Any user-visible behavior change |
| [docs/](docs/README.md) | **System of record**: design docs, plans, quality grades, references | Understanding *why*, or recording a decision |
| `api-docs/` | Generated TypeDoc API site (git-ignored; built in CI, deployed to Pages) | Reading TS-level shapes; never hand-edit |

## Golden rules (invariants)

These are enforced mechanically wherever possible. A change that violates one is a bug.

1. **The SDK is the source of truth for B2.** Never reach for raw HTTP, `fetch`, `boto3`, the
   `b2` CLI, or a shelled-out subprocess. Use `@backblaze-labs/b2-sdk`. See [ARCHITECTURE.md](ARCHITECTURE.md).
2. **`dist/index.js` is committed and generated.** After any `src/` change, run `pnpm build` and
   commit `dist/`; CI fails on drift and caps the bundle at 4 MiB. Never hand-edit `dist/`.
   See [DEVELOPMENT.md](DEVELOPMENT.md#why-dist-is-committed).
3. **Parse, validate, and mask at the boundary.** Inputs are handled once in `src/inputs.ts`;
   secrets are masked there and in `src/client.ts`. Commands never call `core.setOutput` — the
   dispatcher in `src/main.ts` maps typed results to outputs.
4. **Do not rename the User-Agent tokens** `b2-sdk-typescript/` or `b2-github-action/`. The
   version is read from `package.json`; bump it there and it propagates to `src/version.ts` and
   the User-Agent automatically — never hardcode a version literal. See
   [DEVELOPMENT.md](DEVELOPMENT.md#user-agent-contract).
5. **`action.yml` and the README reference tables stay in sync.** The `sync-check` gate fails on
   drift. See [DEVELOPMENT.md](DEVELOPMENT.md#ci-gates).
6. **Style is enforced, not debated.** Biome (2-space, single quotes, no semicolons, 100 cols);
   `exactOptionalPropertyTypes` and `verbatimModuleSyntax` are on; internal imports use `.ts`;
   tests live under `__tests__/` and run against the SDK's `B2Simulator` (no network).
7. **Dependabot PRs run no CI**, and **git history is the human's to move.** Both policies, in
   full, are in [docs/design-docs/conventions.md](docs/design-docs/conventions.md).

## The build and verify loop

One command mirrors CI; run it before every PR:

```bash
pnpm all         # lint + release policy + typecheck + test + build + spellcheck
pnpm verify-dist # build, then `git diff --exit-code dist/` must be clean
```

`pnpm install` wires up husky hooks: `pre-commit` runs every local gate, `pre-push` runs the
coverage gate. The full gate list and what each check enforces is in
[DEVELOPMENT.md](DEVELOPMENT.md#ci-gates).

## Where knowledge lives

This repo is optimized to be legible from the repo itself: if it is not in a versioned file
here, it does not exist for the next run. Push context in. The [`docs/`](docs/README.md) tree is
the system of record — start at its [design-doc index](docs/design-docs/index.md) and
[core beliefs](docs/design-docs/core-beliefs.md). Plans and known deferrals are tracked under
[docs/exec-plans/](docs/exec-plans/README.md); per-area health is graded in
[docs/QUALITY_SCORE.md](docs/QUALITY_SCORE.md).

## Multi-harness note

`AGENTS.md` is the single, tool-agnostic source of guidance. The tool-specific files
[CLAUDE.md](CLAUDE.md) and [GEMINI.md](GEMINI.md) only point back here so no assistant drifts
onto its own stale copy. Put durable guidance here, not in the tool-specific files.
