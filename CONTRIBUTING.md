# Contributing to `backblaze-labs/b2-action`

Thanks for your interest. The Action is intentionally small and built on the official [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript): most behavior changes happen there, not here. This file covers what to do when you genuinely need to change *this* repo. For the repository map and the layering rules, start at [AGENTS.md](./AGENTS.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Local setup

```bash
pnpm install
pnpm all        # lint + release policy + typecheck + test + build + spellcheck
pnpm ci:local   # local validation suite (see AGENTS.md for what stays CI-only)
```

Requirements: Node 24+. pnpm is pinned via the `packageManager` field in `package.json` (currently `pnpm@11.5.3`); with corepack enabled, `pnpm` in this repo uses that version automatically. The action runs on Node 24 in the GitHub Actions runtime; we test against Node 24 on Linux, macOS, and Windows.

`pnpm install` also wires up git hooks (via [husky](https://github.com/typicode/husky)):

- **`pre-commit`** runs `lint + release-provenance policy + typecheck + test + build + dist/ freshness + spellcheck`. Every local code/doc check, every commit, no path-gating.
- **`pre-push`** runs `pnpm test:coverage`, which subsumes the plain `test` already done in `pre-commit`.

Skip a hook with `--no-verify` if you absolutely need to. CI runs the same checks regardless. In the release workflow husky is disabled via `HUSKY=0` so the in-CI `git push` of the floating major tag doesn't re-trigger the local hooks.

GitHub Actions workflow security is centralized in [`.github/workflows/security.yml`](./.github/workflows/security.yml), which calls the shared `backblaze-labs/github-actions` composite action pinned to a commit SHA. That shared action owns actionlint, third-party action pin checks, and zizmor audits so this repo does not carry local copies of those scripts.

## Project shape

```text
src/
  main.ts          # entrypoint: parse inputs, build client, dispatch, set outputs
  inputs.ts        # typed parser + validator for INPUT_* env vars
  client.ts        # B2Client factory + bucket resolver
  sse.ts           # SSE-B2 / SSE-C input parser
  progress.ts      # throttled progress listener
  summary.ts       # $GITHUB_STEP_SUMMARY writer
  outputs.ts       # core.setOutput mapping + summary-json shaping
  errors.ts / format.ts / fs.ts  # error, formatting, and filesystem helpers
  commands/<verb>.ts  # one file per verb (13 verbs); delete-all.ts is a shared helper
__tests__/
  _helpers.ts      # shared `makeInputs()` for tests
  *.test.ts        # unit tests (run against the SDK's B2Simulator, no network)
.github/workflows/
  ci.yml                       # lint, typecheck, test, coverage, build, dist-freshness, smoke
  security.yml                 # shared GitHub Actions workflow security checks
  example-*.yml                # runnable examples that double as integration tests
  release.yml                  # see RELEASE.md
action.yml         # marketplace manifest: inputs, outputs, branding
dist/index.js      # ncc-bundled entrypoint (committed; CI fails if stale)
AGENTS.md          # repository map (multi-harness entry point)
ARCHITECTURE.md    # layers + boundary invariants
REVIEW.md          # how every PR is reviewed
docs/              # system of record (design docs, plans, quality grades)
.claude/           # shared Claude Code skills, subagents, and edit-time hooks
```

## Adding a new verb

The pattern is the same every time:

1. **Implement the command.** Add `src/commands/<verb>.ts` exporting an async `xxxCommand(bucket, inputs)` function (or `(client, bucket, inputs)` if you need the `B2Client`). It should:
   - Validate the inputs it depends on (`source`, `destination`, etc.) and throw a clear error if missing.
   - Use `core.startGroup` / `core.endGroup` to frame the per-call log block.
   - Return a typed result object the dispatcher can map to outputs.
   - **NEVER** call `core.setOutput` directly: that's the dispatcher's job.
2. **Register the verb** in `src/inputs.ts` (`ActionName` type + `VALID_ACTIONS` array).
3. **Add the dispatch case** in `src/main.ts`. Map the typed result to `core.setOutput(...)` calls and call `writeStepSummary({...})` with a friendly per-row table.
4. **Document the inputs/outputs** in `action.yml`. Add any new inputs to the inputs block and any new outputs to the outputs block.
5. **Write tests** under `__tests__/commands/<verb>.test.ts`. Use `makeInputs(action, override)` from `_helpers.ts` and the SDK's `B2Simulator` to drive without a network. Cover happy path + at least one error path.
6. **Add an example workflow** at `.github/workflows/example-<verb>.yml` if the verb has a real CI use case. The example should be copy-paste-runnable for someone in their own repo (with credentials swapped in) AND act as a live integration test against the project's test bucket.
7. **Update the README** verb table and add a short usage snippet.
8. **Run `pnpm build`** and commit the resulting `dist/index.js` change.
9. **Add a changelog fragment** with `pnpm changelog:new` (see [Changelog entries](#changelog-entries)).

## Larger changes and review

Small changes need only a good PR. For larger or riskier work, follow the workflow in [AGENTS.md](./AGENTS.md#workflow-for-larger-changes): the issue carries the intent, a design doc under `docs/design-docs/` carries the spec, and a plan under `docs/exec-plans/active/` carries the steps and the proof. The Claude Code skills under `.claude/skills/` walk through each stage, and `b2-action-invariants` lists the rules a change must not break.

Every PR is reviewed against [REVIEW.md](./REVIEW.md). Run `pnpm ci:local` before asking for review and fill in the Risk and How to revert sections of the PR template. A code owner approves; the author, human or agent, never approves their own change. Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Changelog entries

`CHANGELOG.md` is generated by [changie](https://changie.dev), so never edit it directly. Every PR that changes what ships (`src/`, `dist/`, `action.yml`, dependencies, or the workflows and composite actions under `.github/workflows/` and `.github/actions/`) adds one fragment per user-visible change:

```bash
pnpm changelog:new   # pick a kind (Added, Changed, Deprecated, Removed, Fixed, Security), write one line
pnpm changelog:new --kind Fixed --body "..."   # non-interactive form
```

That writes a small YAML file under `.changes/unreleased/`; commit it with your change. Because each PR adds its own file, parallel PRs no longer conflict on `CHANGELOG.md`. The `changelog` CI check (`pnpm changelog:check` locally) fails a PR that changes a shipped path without adding a fragment. If nothing user-visible changed (a refactor, a dev-only script), a maintainer can label the PR `skip-changelog`. Fragments become a dated version at release time; see [RELEASE.md](./RELEASE.md).

## Tests

- Unit tests run via `pnpm test`. They use the SDK's in-memory `B2Simulator` so no network and no real B2 account is needed.
- Coverage is gated at 95% statements / 85% branches / 100% functions / 95% lines via `pnpm test:coverage`. CI runs this on every PR.
- The example workflows (`.github/workflows/example-*.yml`) are the **integration test suite**. They run against a real Backblaze test bucket on every PR that's not from a fork (forks don't have access to repo secrets and skip silently).

## Style

- Biome handles formatting + linting (config in [`biome.json`](./biome.json)). Run `pnpm lint:fix` before submitting.
- `exactOptionalPropertyTypes` is on. Use conditional spread or explicit optional-property assignment rather than passing `undefined`.
- `verbatimModuleSyntax` is on. Use `import type` for type-only imports.
- Internal relative imports use `.ts` extensions (`import { x } from './foo.ts'`), not `.js`.
- 2-space indent, single quotes, no semicolons, 100-char line width.

## dist/ rebuild

`dist/index.js` is committed because GitHub Actions runs it directly from the repo (no install step). After any change under `src/`, run `pnpm build` and commit the updated `dist/`. CI fails on any PR where `pnpm build` would produce a diff.

The `build-and-check-dist` CI job also enforces a 4 MiB ceiling on `dist/index.js`. If you add a dependency that pushes it over, you'll need to justify the bump in the same PR.

## Opening issues

Please use the issue forms under `.github/ISSUE_TEMPLATE/`:

- **Bug report** for a defect in the Action. Include the action version (`uses:` line with the resolved SHA), the workflow snippet, and the redacted log output.
- **Feature request** for a new verb, input, output, or behavior.
- **Task** for maintenance, tooling, CI, docs, release, or dependency work on the repository. State the outcome, "done when" conditions you can check, the area, and the risk tier from [review-process.md](./docs/design-docs/review-process.md).

## License

By contributing you agree your contribution is licensed under the [MIT License](./LICENSE).
