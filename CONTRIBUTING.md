# Contributing to `backblaze-labs/b2-action`

Thanks for your interest. The Action is intentionally small and built on the official [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript): most behavior changes happen there, not here. This file covers what to do when you genuinely need to change *this* repo.

## Local setup

```bash
pnpm install
pnpm all        # lint + release policy + typecheck + test + build + spellcheck
```

Requirements: Node 24+, pnpm 11+. The action runs on Node 24 in the GitHub Actions runtime; we test against Node 24 on Linux, macOS, and Windows.

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
9. **Add a CHANGELOG entry** under `[Unreleased]`.

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

## Reporting bugs

Please use the issue templates under `.github/ISSUE_TEMPLATE/`. Include the action version (`uses:` line with the resolved SHA), the workflow snippet, and the redacted log output.

## License

By contributing you agree your contribution is licensed under the [MIT License](./LICENSE).
