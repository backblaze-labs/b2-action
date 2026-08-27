# Conventions

Operational conventions for `b2-action` that are not otherwise enforced by a formatter. Code
style and the local/CI command set live in [DEVELOPMENT.md](../../DEVELOPMENT.md#conventions) and
[CONTRIBUTING.md](../../CONTRIBUTING.md#style); this file is the home for the commit, CI-actor,
and git-history policies.

## Commit messages

- One-line subject, imperative mood, under 72 characters.
- Start with a Conventional Commits type prefix: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`, `perf:`, `build:`, `ci:`, or `style:`.
- No AI attribution of any kind: do not add a `Co-Authored-By` trailer for an assistant, and do
  not name an AI tool in the subject or body.
- Release commits are the exception: `pnpm version` writes a bare `X.Y.Z` subject as it cuts the
  changelog and stages `dist/`. See [RELEASE.md](../../RELEASE.md).

## Code style (summary)

The full rules and rationale are in [DEVELOPMENT.md](../../DEVELOPMENT.md#conventions). In short:
Biome formats and lints (2-space indent, single quotes, no semicolons, 100-column width);
`exactOptionalPropertyTypes` and `verbatimModuleSyntax` are on; internal relative imports use
`.ts` extensions; all source is under `src/` and tests under `__tests__/`. Run `pnpm lint:fix`
before pushing.

## CI actor policy: Dependabot PRs run no CI

Dependabot pull requests must not trigger any CI. Every job in every `pull_request`-triggered
workflow is gated on the actor so it is skipped for Dependabot, using the same condition throughout:

```yaml
if: ${{ github.actor != 'dependabot[bot]' }}
```

This is applied directly in
[`ci.yml`](../../.github/workflows/ci.yml),
[`docs-lint.yml`](../../.github/workflows/docs-lint.yml),
[`security.yml`](../../.github/workflows/security.yml), and
[`full-lockfile-audit.yml`](../../.github/workflows/full-lockfile-audit.yml), or folded into an
existing condition that already excludes `dependabot[bot]` in
[`codeql.yml`](../../.github/workflows/codeql.yml),
[`docs.yml`](../../.github/workflows/docs.yml), and every `example-*.yml`. Schedule-only,
tag-only, and push-to-`main`-only workflows (`release.yml`, `daily-smoke.yml`,
`large-multipart-smoke.yml`, `mutation-testing.yml`, and the audit heartbeat) are not
`pull_request`-triggered and need no guard.

When you add a workflow or job that runs on `pull_request`, add the same guard to every job (AND
it into any existing `if:`). Do not rely on branch-name filters: the `pull_request` branch filter
matches the base branch, not Dependabot's head branch.

## Git history is the human's to move

Do not run `git add`, `git commit`, `git push`, `git rebase`, `gh pr create`, or any command that
mutates git history unless the user explicitly asks for that specific action in the current turn.
Edit files freely and suggest the exact commands a human can run, but leave the commit, push, and
merge to them.
