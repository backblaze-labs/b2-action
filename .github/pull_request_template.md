<!--
Thanks for sending a pull request! A few quick checks before submitting:
-->

## Summary

<!-- What does this PR change and why? Link the issue, and the plan in docs/exec-plans/active/ for larger work. -->

## Risk

<!-- Low, Medium, or High (see docs/design-docs/review-process.md). What could this break, and who would notice? -->

## How to revert

<!-- Usually "revert this PR". Call out anything that is not a clean revert: a published release, a moved tag, or data written to B2. -->

## Checklist

- [ ] `pnpm ci:local` passes locally (the full PR gate; see [AGENTS.md](../AGENTS.md)).
- [ ] Reviewed with fresh context against [REVIEW.md](../REVIEW.md) (for example `/code-review` and `/security-review`), and every Important finding is resolved.
- [ ] For a bug fix: the new test fails with the fix reverted.
- [ ] If a reviewer had to point out the same mistake on an earlier PR: [AGENTS.md](../AGENTS.md) or [REVIEW.md](../REVIEW.md) is updated in this PR.
- [ ] If `src/` changed, `dist/index.js` was rebuilt and is included in this PR. CI will fail otherwise.
- [ ] Test coverage for new logic added under `__tests__/` (and passes the 95%/85%/100%/95% coverage gate).
- [ ] If a new `action:` verb was added: it's listed in `src/inputs.ts` `ActionName`, wired in `src/main.ts`, documented in `action.yml`, and has a usage entry in the [README](../README.md).
- [ ] If a new input or output was added: documented in `action.yml` and the README table.
- [ ] If user-visible behavior changed: a changelog fragment from `pnpm changelog:new` (see [CONTRIBUTING.md](../CONTRIBUTING.md#changelog-entries)); otherwise ask for the `skip-changelog` label.
- [ ] If a new example workflow was added: listed in [`.github/workflows/README.md`](./workflows/README.md) and runs against the project's test bucket.

## How to test this

<!-- Workflow snippet a reviewer can copy-paste to exercise the change. -->

```yaml
- uses: backblaze-labs/b2-action@<this-pr's-sha>
  with:
    action: ...
```

## Notes for reviewers

<!-- Anything subtle, intentionally out of scope, or that needs a second pair of eyes. -->
