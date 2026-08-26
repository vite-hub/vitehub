# Security policy

## Supported versions

ViteHub is under active development and has not reached 1.0. Security fixes land on the current `main` branch. Published 0.x packages are development snapshots and do not receive backports.

| Version | Security fixes |
| --- | --- |
| Current `main` | Supported |
| Published 0.x versions | No backports |

If a vulnerability affects a published package, include its exact package name and version in the report. Maintainers may publish a new 0.x release after the fix lands on `main`.

## Report a vulnerability privately

Do not disclose vulnerability details in a public issue, discussion, pull request, or Discord message.

Start on the repository's [GitHub Security Advisories page](https://github.com/vite-hub/vitehub/security/advisories). If GitHub shows a **Report a vulnerability** button, use that form. If the form is unavailable, open a [GitHub issue](https://github.com/vite-hub/vitehub/issues/new) containing only a request for a private security contact. Do not include vulnerability details in that issue. A maintainer will establish a private channel for the report.

Once you have a private channel, include:

- the affected package, version, or commit;
- the practical impact and the conditions required to trigger it;
- reproducible steps or a minimal proof of concept;
- any suggested mitigation or fix;
- your planned disclosure date and whether you want public credit.

Remove credentials, personal data, and private repository content from the report. Do not access data or systems that you do not own or have permission to test.

## Response expectations

Maintainers aim to acknowledge a private report within 7 calendar days and provide an initial assessment within 14 calendar days. These are response targets, not a promise that a fix will be ready within 14 days. Fix timing depends on severity, affected packages, and the work needed to verify the change across supported hosts.

The initial assessment will confirm whether the report is a security issue, request more information, or explain why it does not meet the security threshold. While an accepted report remains open, maintainers will share material status changes in the private thread.

If you have not received an acknowledgement after 7 days, follow up in the same private thread. If no private thread exists yet, comment on the contact-request issue without adding vulnerability details.

## Coordinated disclosure

Keep the report and related fixes private until maintainers publish a security advisory or agree to another disclosure date with you. State any disclosure deadline in the initial report so there is time to assess the issue, prepare a fix, and notify affected users.

Maintainers will coordinate the advisory, fixed release, and reporter credit. You may decline credit. This policy does not promise payment or a bug bounty.

## Use public channels for other reports

Use [GitHub issues](https://github.com/vite-hub/vitehub/issues) for reproducible bugs and documentation gaps. Use the [ViteHub Discord community](https://discord.gg/YTRDsRP3) for implementation questions and design discussion. Neither channel is private, so do not post secrets, customer data, private repository content, or suspected vulnerability details there.
