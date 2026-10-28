# Review lessons

What reviewers keep finding on `b2-action` pull requests, distilled into checks to run before a PR is opened. Every item below was raised on a merged PR; the numbers after each item are the PRs where it came up. Walk the sections for the areas your change touches, and fix what applies before asking for review.

## Where this comes from

A pass over every review on all 48 merged PRs as of 2026-10-27: 192 inline findings across 31 PRs, almost all from Copilot code review, plus the author's reply on each thread. 163 findings were accepted and fixed, 4 were rebutted with evidence, and 25 got no reply (all but one were fixed in later PRs; see [Still open](#still-open)). By area: `src/` 57, `scripts/` 41, workflows and composite actions 38, tests 26, docs and `action.yml` 16, config and dependencies 14.

When a finding shows up on a second PR, add it here in that PR. When a whole class of finding can be caught by a tool, promote it into a test or lint and note that here.

## 1. Docs, comments, and PR text must match the code in the same diff

The single most common finding (about 40). A comment, JSDoc, README row, `action.yml` description, runbook step, or PR description that was true before the change and is false after it.

- [ ] Every comment and JSDoc you touched, or whose subject you changed, still describes the code. Watch rationale comments that state *why*: they rot silently (#34, #69, #71, #76, #77, #79, #91, #212).
- [ ] `action.yml` and README describe when an output is conditional or omitted, not only what it holds (`content-sha1` on multipart, `file-id` on `unhide`) (#60, #77, #135).
- [ ] Runbooks and the workflow they describe agree on order and commands; prefer linking to `RELEASE.md` over duplicating commands in a workflow message (#70).
- [ ] The PR description matches the diff: "test-only" PRs that change `src/`, scope changes, and "fails fast" claims that only warn all got flagged (#68, #90, #164).
- [ ] Error messages point at the input the user should actually use (#135).
- [ ] Documented tool versions match what CI installs (#72), and docs that list a script's steps list all of them (#33).
- [ ] Stale suppressions go when their cause goes (a `zizmor` ignore for a removed line) (#48), and override comments name the current advisory range and the removal condition (#233).

## 2. Tests must prove the behavior, not just pass

About 20 findings. The repeated shape: a test that would still pass if the fix were reverted.

- [ ] Assert the mechanism, not just the outcome. When the fix is "now calls X" or "no longer calls X", assert the call count (#71, six findings on one PR).
- [ ] A retry or backoff test proves the call is still pending before the timers advance, so it fails if retries are removed (#68).
- [ ] Compare sets as sets: sort both sides and de-duplicate; never depend on scheduling order of concurrent work (#55, #63).
- [ ] `expect(x).not.toBeNull()` passes for `undefined`; assert the type you expect (#90).
- [ ] New branches get a test in the same PR, especially error-classification branches (#69).
- [ ] Clean up exactly what the test changed: delete env vars that were unset (assigning `undefined` sets the string `"undefined"`), remove only the signal listeners you added, and create files inside the `try` whose `finally` removes them (#60, #63, #78, #164).
- [ ] Invoke scripts the way CI does (relative `node scripts/...`), or entrypoint bugs slip through (#72).
- [ ] Reuse `__tests__/_helpers.ts` fixtures instead of a local copy (#78).
- [ ] Fixtures mirror the real file shape. A regression fixture that put `version` last in `package.json` (no trailing comma) kept a regex-driven step from ever running, so the test passed against the bug it was written to catch. Prove a regression test against the exact bug shape, not just "remove the fix" (#258).

## 3. Windows and cross-platform

About 11 findings, and the cause of the only Windows CI failure in #258. CI runs `test` on Linux, macOS, and Windows.

- [ ] Spawn `pnpm.cmd` on Windows (`process.platform === 'win32'`), never a bare `pnpm` without a shell (#72, #90).
- [ ] No shell quoting inside `package.json` scripts; `cmd.exe` passes single quotes literally. Put argument lists in a Node wrapper (#73).
- [ ] Path regexes accept both `/` and `\`; text parsers accept CRLF (#66, #73).
- [ ] A module that tests import has no `#!` shebang: split helpers into a shebang-free `*-lib.mjs` and keep the shebang on the CLI only (#258).
- [ ] `rename` over an existing file fails on Windows; unlink first, without following a leaf symlink (#77).
- [ ] Do not infer filesystem case-sensitivity from the platform; probe the real filesystem (#77).
- [ ] Tests that need bash or POSIX permissions skip on Windows explicitly (#70).

## 4. Scripts must never succeed without doing their job

About 10 findings across `scripts/`. The failure mode is a green check that ran nothing.

- [ ] CLI entrypoint detection uses the repo's `realpath` pattern (`realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))`); a raw string compare is false for relative or symlinked invocation and turns the script into a no-op (#72, #73, #90).
- [ ] Numeric env vars are validated to finite positive integers with defaults; `Number('abc')` is `NaN`, which skips retry loops and makes `elapsed > NaN` loops unbounded (#72, #73).
- [ ] Resolve repo paths from `import.meta.url`, not the working directory (#66).
- [ ] Wrap file reads in the same error path as parsing so failures are structured, not stack traces (#66).
- [ ] Clear timers on every exit path, including a spawn `error` (#72).
- [ ] Cleanup that can meet a directory uses `recursive: true`, and replacing a cached binary keeps the old one until the new one is in place (#72, #73).
- [ ] Clear generated report directories before writing so artifacts match the run (#90).
- [ ] A gate validates content, not just file names: the changelog check once accepted an empty `.changes/v*.md` as an entry, and a check that only lists paths must not be the only test. Run the real script against a scratch repo in tests, not only its helpers (#258).
- [ ] When a PR says it closes an issue, check the issue's acceptance criteria against the code: the changelog gate claimed to close #177 while skipping the workflow paths #177 requires (#258).

## 5. Secrets and log safety

About 11 findings, concentrated in error handling (#69).

- [ ] Nothing the SDK or a user supplies reaches `setFailed`, `debug`, an annotation, or an output without scrubbing, including raw URLs that may carry credentials (#69).
- [ ] Register every secret with `core.setSecret` as soon as it is known, before any code that can throw (input parsing included), and keep the empty-value guard (#68, #69).
- [ ] Scrub before truncating, or a secret cut at the boundary leaks its prefix (#69).
- [ ] Bound the work done per secret (derived encodings) and guard encoders that can throw (#69).
- [ ] Percent-encode `%`, `\r`, and `\n` before echoing user input into a workflow command, or it can inject fake annotations (#70).
- [ ] Verify downloaded binaries against a pinned SHA-256 before executing them (#73).
- [ ] Approval gates fail closed. Check the approval lookup's own exit status, not the status of a pipeline it feeds (without `pipefail`, `lookup | jq` reports only `jq`), require a non-empty approver, and deny when the gate itself cannot run. A gate that allowed a production release on a failed lookup or an empty approver was caught on #258.

## 6. GitHub Actions workflows

About 45 findings, the largest group by volume. The security workflow (actionlint, pin checks, zizmor) catches some; these are the ones it did not.

- [ ] Every workflow has a `concurrency` group, scoped to the ref so PR runs do not queue behind `main` (#56, #65, #258).
- [ ] Jobs that need write scopes skip fork PRs, whose token is read-only (#56); every `pull_request` job carries the Dependabot guard (see [conventions.md](conventions.md)).
- [ ] Least privilege, computed as GitHub does: a job with its own `permissions` key gets exactly the scopes it lists and every other scope is `none` (it does not inherit from the workflow), while a job without a `permissions` key uses the workflow-level block. So a job-level mapping must list every scope its steps need, `contents: read` included. `write-all` is a string, not a mapping (#66, #258). (#66 assumed jobs inherit unspecified scopes; the release-provenance policy built on that is stricter than needed, which is safe.) Grant read scopes the steps actually need, such as `attestations: read` for `gh attestation verify` (#66).
- [ ] `on.push.tags` filters are globs, not regexes; validate strictly in a step (#66).
- [ ] Property names used with dot access start with a letter or `_` and contain only letters, digits, `-`, or `_`; hyphens are fine (`steps.release-ref.outputs.release-sha` is valid). Any other name needs index syntax (`outputs['my.output']`). (#66 accepted a finding that hyphenated names parse as subtraction and renamed its outputs; the rename was harmless but unnecessary, #258.)
- [ ] A checkout by SHA does not fetch tags; fetch the tag before `git rev-parse` on it (#66).
- [ ] Reuse a value you already validated instead of re-resolving it later (time-of-check to time-of-use) (#66).
- [ ] Treat any SemVer `-suffix` as a prerelease, consistently with the trigger (#66, #70).
- [ ] REST list endpoints are paginated; query the exact ref, or pass `per_page` and `--paginate` (#70, #72).
- [ ] Leave time inside `timeout-minutes` for failure-escalation steps; put a timeout on the slow command, not only the job (#72).
- [ ] Tracking-issue automation edits one issue instead of commenting every run, truncates bodies to stay under GitHub's size limit, filters by author client-side, and does not hide stderr (#72).
- [ ] Use the repository default branch, not a hardcoded `main` (#72).
- [ ] Cache only runner-controlled paths (`${{ runner.temp }}`), with the architecture in the key (#73).
- [ ] Installs in CI that do not need hooks skip lifecycle scripts (`--ignore-scripts`) (#75).
- [ ] Prefer `gh ... -q` over shelling out to tools the job did not set up (#66).
- [ ] Gate on a third-party action's own preconditions so a miss skips instead of failing. `claude-code-action` throws unless the triggering actor is a `User` account, and a job `if` that excludes only Dependabot still lets `github-actions[bot]` or `Copilot` (an actor with no `[bot]` suffix) fail it; check the actor type the way the action does (#258).

## 7. Concurrency, cancellation, and failure paths in `src/`

About 16 findings.

- [ ] Do not multiply parallelism: when files run in parallel, each file's multipart part concurrency drops to 1, unless there is a single file (#55).
- [ ] A worker pool records the first error, stops scheduling, waits for in-flight work, then rethrows; `Promise.all` returns while work keeps running. Track failure with a flag, not an `undefined` sentinel (#55).
- [ ] Long loops check the `AbortSignal` before each request, and an abort propagates instead of becoming a per-item "failed" event (#132).
- [ ] A diagnostic guard on an error path must not replace the original error (the `summary-json` cap on failing `sync`, `delete`, `purge`) (#76).
- [ ] Branch on structured data, never on the wording of a message (#77).
- [ ] Re-check path safety immediately before each write, not only at planning time (#77).

## 8. Contract, determinism, and B2 fidelity

About 15 findings.

- [ ] Outputs are kebab-case like every existing output (#60).
- [ ] Anything that becomes an output or a report is sorted, so results do not depend on `readdir` order (#55, #60).
- [ ] Local validation matches B2's real limits and semantics, checked against the B2 docs or a live test, not assumed (#71, #135). Production `listFileNames` omits hidden names, which the simulator does not mirror (#71).
- [ ] Path containment checks match `..` exactly; `..foo` is a legal name inside the root (#77).
- [ ] Path guards normalize before matching (`./dist`, `src/../dist`, `/./dist`, symlinked ancestors); a raw string prefix match lets equivalent spellings through (#258).
- [ ] Do not re-stat or re-fetch what you already have (#135).

## 9. Dependencies and config

About 10 findings.

- [ ] Overrides carry a current-major ceiling (`'>=x.y.z <next.0.0'`), and the floor is the first patched release, not an older one that still admits the advisory (#72, #233).
- [ ] Never hand-edit `pnpm-lock.yaml`; regenerate it (#211).
- [ ] A dependency change that ships in `dist/` gets a changelog fragment that names exactly what changed (#233).
- [ ] Keep `.cspell/project-words.txt` sorted and drop words nothing uses (#90, #233).

## Review process lessons

- **Verify a fix landed before replying "Fixed".** One finding came back on the same PR because the reply said "Fixed" but the pushed diff still had the old text (#34). Reply with the commit that contains the fix.
- **Give automated reviewers the review history.** `gh pr view --comments` shows conversation comments, not inline threads, so a reviewer told "do not repeat findings" cannot comply without the threads, their replies, and their resolution state; `claude-review.yml` fetches them first (#258).
- **A skipped check is not a passing check.** The Claude review jobs pass by skipping until the API key exists; do not make them required until they have run for real (#258).
- **Expect re-reports of fixed findings.** A second automated pass can review an older commit and repeat findings already fixed (#258). Check which commit the review targeted before changing code.
- **Accepted is not the same as correct.** Two findings accepted on #66 rested on false premises about GitHub Actions: that job-level `permissions` inherit unlisted scopes from the workflow, and that hyphenated property names break dot access. Both were caught later on #258. Before acting on a claim about platform behavior, check it against the platform's documentation.
- **Rebut with evidence when the reviewer is wrong.** The 4 rejected findings were all disproved by a primary source: the pinned `actions/setup-node` `action.yml` supports `package-manager-cache` (#66, #70), production B2 omits hidden names (#71), and the Windows `pnpm.cmd` default already existed (#90). Cite the source in the reply.

## Still open

- #65: `.github/workflows/docs.yml` uses a workflow-wide `concurrency: group: pages`, so PR doc builds queue behind each other and behind the `main` Pages deploy. Scope the group to the ref for PR runs while keeping `main` deploys serialized.
