<!--
Thanks for sending a pull request! A few quick checks before submitting:
-->

## Summary

<!-- What does this PR change and why? -->

## Checklist

- [ ] `pnpm all` passes locally (lint + release policy + typecheck + test + build + spellcheck).
- [ ] If `src/` changed, `dist/index.js` was rebuilt and is included in this PR. CI will fail otherwise.
- [ ] Test coverage for new logic added under `__tests__/` (and passes the 95%/85%/100%/95% coverage gate).
- [ ] If a new `action:` verb was added: it's listed in `src/inputs.ts` `ActionName`, wired in `src/main.ts`, documented in `action.yml`, and has a usage entry in the [README](../README.md).
- [ ] If a new input or output was added: documented in `action.yml` and the README table.
- [ ] If user-visible behavior changed: a [`CHANGELOG.md`](../CHANGELOG.md) entry under `[Unreleased]`.
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
