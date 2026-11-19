# ViteHub

ViteHub is an ambitious open source project for server primitives and portable Agents across Vite hosts. We are building the missing server layer for the UnJS ecosystem. A good idea is worth exploring. Keep the final contract clear enough that a developer or an Agent can use it without learning the internal machinery first.

You are working with Maxi. Keep the work direct, practical, and easy to review.

Before you design, change, review, or document anything in this repository, read the [ViteHub Dev skill](.agents/skills/vitehub-dev/SKILL.md). It explains how we decide: primitives, public API size, breaking changes, docs, proof, and pull requests.

## How we work

- Write short, plain English. Use ASD-STE100 language.
- Keep the scope focused. Prefer the smallest change that makes the public contract better.
- Use the existing Vite, Nuxt, Vue, TypeScript, and pnpm stack.
- Build for Nuxt 5 and Nitro 3 only. Add no code, tests, or docs for Nuxt 4 or Nitro 2 (`nitropack`).
- Prefer inferred types. Do not use `any`.
- Put shared behavior in the package that owns it. Keep product workflows in consumers.
- Preserve other people's changes. Inspect collisions before editing.
- Ask before production work, deployments, live databases, or maintainer servers.
- A direct request to fix, implement, commit, or open a pull request is authorization for that action.

## Project language

ViteHub has Server Primitives, Agent Definitions, Drivers, Invocations, Capabilities, Workspaces, Sources, framework integrations, and generated host output. Use these names consistently. Runtime policy belongs in its owner package. Console code may inspect runtime behavior but must not own it.

Use Better Auth as a reference for composability and UnJS as a reference for host independent runtime behavior. Build primitives that developers should not recreate. Product specific workflows belong in consumers when they can be composed from ViteHub primitives.

## Code map

- `packages/vite-hub/src/`: framework distribution, discovery, generated output, and host integration
- `packages/agent/src/`: Agent Definitions, Drivers, Invocations, and Capabilities
- `packages/runtime/src/`: shared runtime contracts
- `packages/workspace/src/`, `packages/source/src/`: file trees, access, and mounted Sources
- `packages/*/src/`: each Server Primitive or integration
- `docs/`: documentation and the first party website
- `fixtures/`, `test/consumer/`, `test/output/`: consumer and generated output proof

## Native first

Use the web platform before JavaScript, and JavaScript before a dependency. A native feature has less code to ship, test, and keep in step with the browser.

**Support floor.** ViteHub supports the latest two Chrome releases, the latest two Firefox releases, and the current and previous Safari major (November 2026: Chrome 157–158, Firefox 159–160, Safari 27.1–27.2). `browserTarget` in `packages/internal/src/package-exports.ts` writes this floor for the build. Change both when the floor moves.

**Check the feature on [webstatus.dev](https://webstatus.dev).** Open the feature, such as [popover](https://webstatus.dev/features/popover), and read the version of each browser in the floor.

- **All of them have it:** use it directly. Add no fallback and no feature check.
- **One is missing it, and the page still works without it:** use it under `@supports` (or `CSS.supports()`, `"x" in el`) with no fallback. The missing browser gets the plain version. Example: `field-sizing: content` on a text field.
- **One is missing it, and the page breaks without it:** keep the JavaScript that does the job. Or load a polyfill behind a feature check, with a dynamic `import()` in bundled code, so supported browsers do not download it. Never put a polyfill in an inline script or a script that a page loads without a bundler, and never load one from a polyfill CDN.

**Dates.** Do not add a date library such as dayjs, moment, date-fns, or luxon. Use `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, and `Date`. When stable Safari ships Temporal, use Temporal, with `temporal-polyfill/global` loaded through a dynamic `import()` behind a `"Temporal" in globalThis` check, in app bundles only.

**Overlays.** Follow rule 6 in [docs/DESIGN.md](docs/DESIGN.md): Vue overlays use Nuxt UI, and plain-DOM code uses the native popover, `<dialog>`, and anchor positioning.

**Server code** also runs on the Node floor in the root `package.json` `engines` (Node 24.15 today). Check a feature on [node.green](https://node.green) or the Node docs, not only on webstatus.dev.

**Known exceptions.** Each one has a reason. Remove it when the reason goes away.

| Code | Why it does not use the native feature |
| --- | --- |
| The account menu placement in `packages/internal/src/runtime/page-account.ts` | It is placed with JavaScript. The page pill moves with CSS `translate` (`page-pill.ts`), and Firefox ignores the anchor's transform when it places an anchor-positioned popover, so the menu opens away from the button. |
| `scrollIntoView({ container })` | Chrome only. Scroll the container with `scrollTo()`. |
| `interestfor` (open on hover or focus) | Chrome only. Open hover cards with JavaScript. |

`test/native-first.test.ts` checks the parts that code can check: no date library in a package manifest, no polyfill CDN, and `document.execCommand("copy")` only in the CopyButton fallback for pages that are not a secure context.

## Diagnostic codes

Name a new catalog code `<PREFIX>_<WHAT_FAILED>`, such as `AUTH_FORWARD_AUTH_INCOMPLETE`, and put its key in alphabetical order among the codes of its catalog group, so concurrent pull requests edit different lines. Published numbered codes, such as `AUTH_C0068`, keep their names. Write the `why` and `fix` in the catalog: the docs build writes the code's page. Put more text in `docs/diagnostics/<CODE>.md`. `test/diagnostic-codes.test.ts` checks these rules.

## Before and after a change

Read the nearest package README. Trace contract changes from configuration through generated output, runtime behavior, and consumers. Check every affected host, provider, and configuration form.

From a clean checkout, install the Node version required by `package.json` and the Deno version in [`.deno-version`](.deno-version). Use the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/) for Deno. Then install the workspace dependencies and check the contributor tools:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm exec vp run preflight
```

`preflight` checks the pinned Deno version. Run it before the full verification gate so a missing or different Deno installation is clear as a setup issue.

Run focused checks for the files you changed. The package `typecheck` and `test` scripts build the package and its workspace dependencies first. For one test file, build with the cached Vite+ target, then run Vitest from the package directory. Do not run repository wide suites unless the task needs them.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --dir packages/vite-hub run typecheck
corepack pnpm --dir packages/vite-hub run test
corepack pnpm exec vp run --cache -t vite-hub#build && corepack pnpm --dir packages/vite-hub exec vp test test/<file>.test.ts
corepack pnpm exec vp run verify
```

Use the affected package name in vp targets and its directory in pnpm --dir commands. For example, use @vite-hub/agent#build as the vp target and packages/agent as the --dir path. The verify command is the full local gate and needs the Deno version in .deno-version.

### Doctor

[Doctor](https://vite-doctor.onmax.me) checks the lines that your branch changes. `doctor.config.json` selects the rules. The `doctor` CI job runs the same check on each pull request and fails if Doctor reports a finding. Run it before you push:

```sh
git fetch origin main
corepack pnpm exec vp run doctor:typescript
```

The task compares with the merge base of `origin/main`. Set `VITE_DOCTOR_SINCE` to compare with a different Git ref.

Fix each finding in the code. Each finding gives a fix and a link to its Diagnostic Code page. Do not suppress a finding to make the check pass. If the code is correct and the finding is wrong for one line, add a `doctor-disable-next-line <rule> -- <reason>` or a `// SAFETY:` comment. Write a reason that is true only for that line. Do not copy a reason from a different line. Doctor's instructions for agents are in [`node_modules/vite-doctor/docs/skills/doctor/SKILL.md`](node_modules/vite-doctor/docs/skills/doctor/SKILL.md).

Report what changed, why, what you verified, and any remaining uncertainty. Keep the response in normal prose. Return JSON, HTML, or other machine formats only when the user explicitly asks for that format.

## Pull requests

Keep one concern per pull request. Use a clear conventional title and start the body with the user visible problem and result. Include focused validation. Do not merge, force push, or deploy without explicit authorization. Use an isolated worktree for pull request work and never remove pre existing work.

## Review guidelines

Automated reviewers read this section. The Babysitter fixes P0 and P1 findings and declines most P2 findings, so a finding below that bar only adds a review round.

- Report defects only: P0 (security hole, data loss, broken main path) and P1 (real bug on a supported path, broken documented contract). Do not post style, naming, wording or cleanup comments.
- Post a P2 (edge case, missing test, docs gap) only when the fix is small and inside the PR's scope. A case that needs forged or hostile runtime objects is P2 at most. Code that the PR did not change is "Pre-existing" and P2 at most.
- Name the bug class and list every instance in the diff in one comment, so the author fixes the class once.
- On a re-review, review only the commits since your last review. Do not repeat a finding that is already on the PR, and do not report a new case of a class that is already reported.
- When the new commits only merge the base branch, report nothing unless the merge changed lines that the PR adds or changes.
- From the third review of a PR on, when the new findings are more cases of an earlier class, post one comment that the approach does not converge and propose a simpler contract instead of more cases.
