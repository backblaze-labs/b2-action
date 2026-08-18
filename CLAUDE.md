# CLAUDE.md

Instructions for AI assistants working on `backblaze-labs/b2-action` (the Backblaze B2 GitHub Action).

## Project overview

A GitHub Action that wraps `@backblaze-labs/b2-sdk` to upload, download, sync, copy, and manage Backblaze B2 Cloud Storage from a CI workflow. Node 24 JavaScript action, single `dist/index.js` produced by [`@vercel/ncc`](https://github.com/vercel/ncc).

The SDK at [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript) is the source of truth for B2 wire-protocol concerns. Whenever you'd reach for raw HTTP, `fetch`, `boto3`, the `b2` CLI, or a shelled-out subprocess: stop and use the SDK instead.

## Conventions

This repo mirrors the SDK's style as closely as practical:

- Biome formatter / linter, 2-space indent, single quotes, no semicolons, 100-char line width.
- `exactOptionalPropertyTypes` ON. Use conditional spread `...(v !== undefined ? { k: v } : {})` instead of passing `undefined`.
- `verbatimModuleSyntax` ON. Use `import type` for type-only imports.
- Internal relative imports use `.ts` extensions, not `.js`.
- All source under `src/`. Tests under `__tests__/` next to the repo root (so we don't ship them in `dist/`).

## Commands

```bash
pnpm install
pnpm lint        # biome check --error-on-warnings
pnpm lint:fix
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run, against B2Simulator
pnpm build       # ncc build src/main.ts -o dist
pnpm all         # lint + release policy + typecheck + test + build + spellcheck
pnpm verify-dist # build, then `git diff --exit-code dist/`: must be clean before commit
```

## Architecture

`src/main.ts` is the entrypoint. It:

1. Calls `parseInputs()` (`src/inputs.ts`) which reads `INPUT_*` env vars via `@actions/core`, validates them, applies the credential-fallback chain (`application-key-id` input → `B2_APPLICATION_KEY_ID` env var; same for the secret), and masks the secret value.
2. Calls `buildClient(...)` (`src/client.ts`) which constructs a `B2Client` with `userAgent: 'b2-github-action/<version>'`, authorizes, and masks the resulting auth token.
3. Dispatches on `inputs.action` to a command module under `src/commands/`. Each command returns a structured result.
4. Maps the result onto `core.setOutput(...)` calls.
5. Any thrown error becomes `core.setFailed(msg)`.

## Command files

Each `src/commands/<verb>.ts` exports one async function that takes `(bucket: Bucket, inputs: ParsedInputs)` and returns a typed result. The function does its own progress reporting (via `src/progress.ts`) and `core.startGroup` / `core.endGroup` framing. It does NOT call `core.setOutput`: that's the dispatcher's job.

## User-Agent

The SDK enforces a stable `b2-sdk-typescript/<v>` + `@backblaze-labs/b2-sdk` prefix in the User-Agent. We append `b2-github-action/<v>` so Backblaze server-side logs can identify CI traffic. **Do not rename either token.** The version constant lives in `src/version.ts` and must be bumped in lockstep with `package.json` `version`.

## dist/

`dist/index.js` (and its sourcemap) is committed to git: GitHub Actions reads it directly. CI fails if `pnpm build` produces a diff that wasn't committed. Always run `pnpm build` before opening a PR that changes anything under `src/`.

## Testing

Tests run against the SDK's in-memory `B2Simulator` (`@backblaze-labs/b2-sdk/simulator`). No real network. Pattern (see `__tests__/commands/upload-download.test.ts`):

```ts
const sim = new B2Simulator()
const client = new B2Client({
  applicationKeyId: 'test-key-id',
  applicationKey: 'test-key',
  transport: sim.transport(),
})
await client.authorize()
const bucket = await client.createBucket({ bucketName: 'gh-action-test', bucketType: 'allPrivate' })
```

The `__tests__/inputs.test.ts` file exercises the env-var fallback chain by setting `INPUT_*` env vars directly. Always clear them in `beforeEach` to avoid cross-test bleed.

## CI policy: Dependabot PRs run no CI

Dependabot pull requests must not trigger any CI. Every job in every `pull_request`-triggered workflow is gated on the actor so it is skipped for Dependabot, using the same condition throughout:

```yaml
if: ${{ github.actor != 'dependabot[bot]' }}
```

This is applied directly (`ci.yml`, `docs-lint.yml`, `security.yml`, `full-lockfile-audit.yml`) or folded into an existing condition that already excludes `dependabot[bot]` (`codeql.yml`, `docs.yml`, every `example-*.yml`). Schedule-only, tag-only, and `push`-to-`main`-only workflows (`release.yml`, `daily-smoke.yml`, `large-multipart-smoke.yml`, `mutation-testing.yml`, the audit heartbeat) are not PR-triggered and need no guard.

When adding a new workflow or job that runs on `pull_request`, add the same `github.actor != 'dependabot[bot]'` guard to every job (AND it into any existing `if:`). Do not rely on branch-name filters: the `pull_request` branch filter matches the base branch, not Dependabot's head branch.

## Git policy

Do not run `git add`, `git commit`, `git push`, `git rebase`, `gh pr create`, or any command that mutates git history unless the user explicitly asks for that specific action in the current turn. Edit files freely; suggest commands the user could run.
