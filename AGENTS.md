# ViteHub

ViteHub is an open source server layer for the UnJS ecosystem: server primitives and portable Agents that run the same on every Vite host. Keep each contract clear enough that a developer or an Agent can use it without learning the internal machinery first.

Before you design, change, review, or document anything here, read the [ViteHub Dev skill](.agents/skills/vitehub-dev/SKILL.md). It explains how we decide. [CONTRIBUTING.md](CONTRIBUTING.md) has the procedures and commands.

## How we work

- Write short, plain English. Use ASD-STE100 language.
- Build for Nitro 3 only: Nuxt 5, or Nuxt 4.7 and newer with the `nitro` package. Add no code, tests, or docs for Nitro 2 (`nitropack`) or for Nuxt before 4.7.
- Use inferred types. `any` is not allowed.
- The repository is public. Published code, docs, examples, and tests name no maintainer's private people, machines, or apps. Use a neutral app name.
- A direct request to fix, implement, commit, or open a pull request is authorization for that action. Ask before production work, deployments, live databases, or maintainer servers.

## Project language

ViteHub has Server Primitives, Agent Definitions, Drivers, Invocations, Capabilities, Workspaces, Sources, framework integrations, and generated host output. Use these names consistently.

- Runtime policy belongs in its owner package. Console code may inspect runtime behavior but must not own it.
- Keep Console-owned data, such as Hosted Comments, in the Console database. The Console can call signed app operations to change app-owned data under the app's access rules.
- The `vitehub` CLI and the ViteHub MCP expose the same operations by default. Document exceptions and why they exist.

## Native first

Use the web platform before JavaScript, and JavaScript before a dependency.

**Support floor.** The latest two Chrome and Firefox releases, and the current and previous Safari major. `browserTarget` in `packages/internal/src/package-exports.ts` holds the floor for the build; change it when the floor moves. Server code also runs on the Node floor in the root `package.json` `engines`.

**Check the feature** on [webstatus.dev](https://webstatus.dev) (server code: [node.green](https://node.green)), for each browser in the floor:

- **All of them have it:** use it directly, with no fallback and no feature check.
- **One is missing it, and the page still works without it:** use it under `@supports` (or `CSS.supports()`, `"x" in el`) with no fallback. Example: `field-sizing: content` on a text field.
- **One is missing it, and the page breaks without it:** keep the JavaScript that does the job, or load a polyfill behind a feature check with a dynamic `import()` in bundled code. Never put a polyfill in an inline script or an unbundled script, and never load one from a polyfill CDN.

**Dates.** Use `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, and `Date`; add no date library. When stable Safari ships Temporal, use Temporal, with `temporal-polyfill/global` loaded through a dynamic `import()` behind a `"Temporal" in globalThis` check, in app bundles only.

**Clipboard.** Copy with `navigator.clipboard` or CopyButton. `document.execCommand("copy")` stays only in CopyButton's fallback for pages that are not a secure context.

**Overlays.** Follow rule 6 in [docs/DESIGN.md](docs/DESIGN.md): Vue overlays use Nuxt UI, and plain-DOM code uses the native popover, `<dialog>`, and anchor positioning.

**Known exceptions.** Remove each one when its reason goes away.

| Code | Why it does not use the native feature |
| --- | --- |
| The account menu placement in `packages/internal/src/runtime/page-account.ts` | The page pill moves with CSS `translate` (`page-pill.ts`), and Firefox ignores the anchor's transform when it places an anchor-positioned popover, so the menu opens away from the button. |
| `scrollIntoView({ container })` | Chrome only. Scroll the container with `scrollTo()`. |
| `interestfor` (open on hover or focus) | Chrome only. Open hover cards with JavaScript. |

## Comments

Write no comments. Name the code so it needs none, and file an issue for a workaround. The `vitehub/no-comments` lint rule keeps only comments that a tool reads, such as `// SAFETY:` and `@ts-expect-error`, and JSDoc on exported API in `packages/*/src`. When the rule fails, or when you touch a file that has comments, use the [delete-comment skill](.agents/skills/delete-comment/SKILL.md).

## Diagnostic codes

Name a new catalog code `<PREFIX>_<WHAT_FAILED>`, such as `AUTH_FORWARD_AUTH_INCOMPLETE`, and put its key in alphabetical order in its catalog group, so concurrent pull requests edit different lines. Published numbered codes, such as `AUTH_C0068`, keep their names. Write the `why` and `fix` in the catalog; put more text in `docs/diagnostics/<CODE>.md`.

## Before you push

Read the nearest package README. Trace a contract change from configuration through generated output, runtime behavior, and consumers, on every affected host, provider, and configuration form. Pick focused checks with [CONTRIBUTING.md](CONTRIBUTING.md#verify-the-changed-behavior); run the repository-wide `vp run verify` only when the task needs it. CI must not be the first check of your change.

- Run `corepack pnpm exec vp check --no-fmt <changed files>` on lintable files, and the `typecheck` and `test` scripts of each changed package. They build their workspace dependencies first.
- Run Doctor on the lines your branch changes: `git fetch origin main && corepack pnpm exec vp run doctor:typescript`. The `doctor` CI job fails on any finding. A finding on a line you changed is yours to fix. Fix it in the code. Suppress one only when the code is correct, with `doctor-disable-next-line <rule-id> -- <reason>` and a reason true for that line only. Doctor's agent instructions are in `node_modules/vite-doctor/docs/skills/doctor/SKILL.md`.

## Pull requests

- One concern per pull request, in an isolated worktree. Never remove work that was there before. Build related pull requests as a stack with the `gh stack` extension.
- Use a conventional title, and start the body with the user-visible problem and result. Include focused validation.
- Push each fix to the branch of the open pull request for that change. Open a new pull request only for a new concern.
- The Babysitter (`vite-hub[bot]`) merges a pull request once a maintainer approves it. Do not merge, force push, or deploy yourself without explicit authorization.

## Review guidelines

Automated reviewers read this section. The Babysitter fixes P0 and P1 findings and declines most P2 findings, so a finding below that bar only adds a review round.

- Report defects only: P0 (security hole, data loss, broken main path) and P1 (real bug on a supported path, broken documented contract). Do not post style, naming, wording or cleanup comments.
- Post a P2 (edge case, missing test, docs gap) only when the fix is small and inside the PR's scope. A case that needs forged or hostile runtime objects is P2 at most. Code that the PR did not change is "Pre-existing" and P2 at most.
- Name the bug class and list every instance in the diff in one comment, so the author fixes the class once.
- On a re-review, review only the commits since your last review. Do not repeat a finding that is already on the PR, and do not report a new case of a class that is already reported.
- When the new commits only merge the base branch, report nothing unless the merge changed lines that the PR adds or changes.
- From the third review of a PR on, when the new findings are more cases of an earlier class, post one comment that the approach does not converge and propose a simpler contract instead of more cases.
