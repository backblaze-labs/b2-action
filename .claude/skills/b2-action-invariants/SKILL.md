---
name: b2-action-invariants
description: Enforce the must-hold rules of this repository (SDK-only B2 access, dist rebuild, input and secret boundaries, User-Agent tokens, action.yml and README sync, CHANGELOG entry, tests that pin the fix, TypeScript style, SHA-pinned and Dependabot-guarded workflows). Use whenever editing src/, __tests__/, action.yml, README.md, CHANGELOG.md, package.json, or .github/workflows/ in b2-action, adding or changing a verb, input, or output, or preparing a pull request.
---

# b2-action invariants

These restate the golden rules in [AGENTS.md](../../../AGENTS.md) as checks to apply while you work. Each names the gate that enforces it, so a rule missed here is still caught at the pull request.

When you change this repository:

1. Use `@backblaze-labs/b2-sdk` for every B2 operation. No raw HTTP, `fetch`, `b2` CLI, or subprocess. (Golden rule 1; [ARCHITECTURE.md](../../../ARCHITECTURE.md))
2. After any `src/` change, run `pnpm build` and commit `dist/`. Never hand-edit `dist/`. (Golden rule 2; CI `build-and-check-dist` and its 4 MiB budget; the `guard-dist` hook)
3. Parse and validate inputs only in `src/inputs.ts`, and mask secrets there and in `src/client.ts`. Commands return typed results and never call `core.setOutput`. (Golden rule 3)
4. Never rename the `b2-github-action/` or `b2-sdk-typescript/` User-Agent tokens, and never hardcode a version literal. (Golden rule 4; the release bake gate)
5. When an input or output changes, update `action.yml` and the README tables in the same change. (Golden rule 5; `pnpm docs:check-action-yml`, CI `sync-check`)
6. Add a CHANGELOG `[Unreleased]` entry for every user-visible change, under the right Keep a Changelog group. (CONTRIBUTING.md; the RELEASE.md pre-release checklist)
7. Start a bug fix with a test that fails before the fix and passes after it. Assert the outputs and the arguments passed to the SDK, not only that nothing threw. Keep coverage at 95 / 85 / 100 / 95. (CI `coverage`; [REVIEW.md](../../../REVIEW.md))
8. Use conditional spread for optional properties, `import type` for type-only imports, and `.ts` extensions on internal imports. (Golden rule 6; `pnpm typecheck`, `pnpm lint`, the `biome-check` hook)
9. In workflows, pin third-party actions to a full commit SHA with a `# vX.Y.Z` comment, keep `persist-credentials: false` and least-privilege `permissions`, and guard every `pull_request` job with the Dependabot condition in [conventions.md](../../../docs/design-docs/conventions.md). (Golden rule 7; `security.yml`, `__tests__/workflow-policy.test.ts`)

Before reporting the task done, run `pnpm ci:local` and paste the end of its output. If a check fails, fix the code, not the check.
