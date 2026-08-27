# References

External material an agent may need in-context while working here. Prefer versioned sources you
can inspect; keep this list short and current.

## The SDK (source of truth for B2)

- [`@backblaze-labs/b2-sdk` repository](https://github.com/backblaze-labs/b2-sdk-typescript) — the
  library every verb dispatches into. Behavior at the wire is defined here.
- [SDK API docs](https://backblaze-labs.github.io/b2-sdk-typescript/) — the TypeScript-level
  shapes (`B2Client`, `Bucket`, `synchronize`, encryption settings) this Action builds on.

## This Action's generated reference

- The TypeDoc API site is built from `src/` into `api-docs/` and deployed to GitHub Pages
  ([backblaze-labs.github.io/b2-action](https://backblaze-labs.github.io/b2-action/)). It is
  generated, git-ignored, and never hand-edited; the config is in `typedoc.json`.

## Tooling

- [lycheeverse/lychee](https://github.com/lycheeverse/lychee) — the link checker behind
  `pnpm docs:links`; the pinned-binary runbook is in
  [DEVELOPMENT.md](../../DEVELOPMENT.md#managed-lychee-binary).
- [markdownlint rules](https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md) — the
  prose-style gate; config in `.markdownlint-cli2.jsonc`.
- [cspell](https://cspell.org/) — the spell gate; project terms live in `.cspell/project-words.txt`.
- [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
  [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — the formats
  [CHANGELOG.md](../../CHANGELOG.md) follows.
