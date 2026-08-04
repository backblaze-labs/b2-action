# Security policy

## Supported versions

Security fixes ship in the latest released `1.x` version. Pin to a released `vX.Y.Z` tag (or a commit SHA) and upgrade to the newest `1.x` release to receive them; older minor versions are not separately patched.

## Reporting a vulnerability

If you find a security issue in this Action, please **do not** open a public GitHub issue. Instead:

1. Email the Backblaze security team: **security@backblaze.com**.
2. If the issue is specific to this Action (not a B2 service-level concern), copy the maintainers at **opensource@backblaze.com**.

Please include:

- A clear description of the vulnerability and the impact you observed.
- Reproduction steps, including the action version (`uses: backblaze-labs/b2-action@<ref>`), the inputs that trigger it, and the workflow context.
- Any logs you can share **after redacting credentials**: see the redaction guidance below.

We will acknowledge within **5 business days** and provide a remediation timeline once we've reproduced the issue.

## Redaction guidance

This Action calls `core.setSecret` on:

- The `application-key` input value.
- The B2 authorization token returned by `b2_authorize_account`.
- Any presigned download URL it emits.

GitHub's workflow runner automatically masks these in the live log. However, **if you copy logs to email or a screenshot**, that masking does not travel with the text. Before sharing:

- Replace your application key ID and secret with `<REDACTED>`.
- Replace any URL containing `Authorization=` with `<REDACTED-URL>`.
- Strip any `x-bz-content-sha1` headers if you consider your content sensitive.

## Scope

This policy covers the source under [`src/`](./src), the bundled [`dist/index.js`](./dist), and the workflows under [`.github/workflows/`](./.github/workflows). Vulnerabilities in [`@backblaze-labs/b2-sdk`](https://github.com/backblaze-labs/b2-sdk-typescript) should be reported through that repository's security policy. Vulnerabilities in the B2 service itself should go to [security@backblaze.com](mailto:security@backblaze.com) directly.

## Out of scope

- Lost-credential incidents: rotate your application key in the [Backblaze B2 console](https://secure.backblaze.com) and revoke the leaked one. This Action cannot recover or invalidate a leaked key on your behalf.
- Workflow misconfiguration that grants more access than intended (e.g. using a master application key in a public repo's workflow). Use bucket-scoped, capability-limited application keys.

## Disclosure timeline

We aim to coordinate disclosure as follows:

1. **Day 0**: report received and acknowledged.
2. **Days 1-5**: triage and reproduction.
3. **Days 6-30**: fix developed, tested, and prepared for release.
4. **Day 30-45**: coordinated public disclosure alongside a patched release.

We may move faster for high-severity issues or, for low-severity issues, batch the fix into the next regular release.
