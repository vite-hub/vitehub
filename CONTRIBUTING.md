# Contributing to ViteHub

Use this guide to turn a requested behavior into a tested change. [AGENTS.md](AGENTS.md) contains the code map, critical boundaries, and permission rules.

## Set up a checkout

Use the Node version required by `package.json`. For the full verification gate, install the Deno version in `.tool-versions` with the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/). CI reads the same pin.

From a clean checkout, let Corepack select pnpm from `package.json` and install the workspace dependencies. This also installs Vite+.

```sh
corepack pnpm install --frozen-lockfile
```

Check the contributor tools without running tests:

```sh
corepack pnpm exec vp run preflight
```

Then run the full local gate:

```sh
corepack pnpm exec vp run verify
```

`verify` runs the preflight first and includes the native Deno package consumer test. A missing or different Deno version is a contributor setup error, not a ViteHub runtime failure. Package scripts own package-local test, build, and typecheck behavior.

A global `vp` installation is not required. Use `corepack pnpm exec vp` after installation. Node and pnpm requirements come from `package.json`; the Deno pin comes from `.tool-versions`. The current preflight checks Deno. It does not validate credentials or every provider tool.

## Start with one user outcome

Reopen the latest issue, PR, screenshot, or consumer. State the input, action, and result that will prove completion. Name adjacent behavior that must remain unchanged. Start with one real feature before changing the delivery process.

Trace only the parts the feature uses: interface or CLI, server entry, runtime, persistence, background work, and external services. For state or resource owners, cover applicable failure, abort, cancellation, timeout, cleanup, restart, and concurrent reuse behavior. A mock proves only the boundary it controls.

Keep one owner responsible for integration and completion. Record commands and interventions in the PR; do not add a separate tracking system. Separate blocking defects from optional improvements. Add process only when this work shows why it is needed.

## Verify the changed behavior

Package scripts own package-local build, test, and typecheck behavior. [`vite.config.ts`](vite.config.ts) and [`test/tasks.ts`](test/tasks.ts) define root tasks. [`test/layers.ts`](test/layers.ts) defines test discovery. Use these files when task details change; do not create a second task registry.

Start with the affected package. The package runner builds its dependency graph before package tests:

```sh
node test/run-package-task.mjs test --packages vite-hub
```

For one regression, build first, then run from the package directory so Vitest uses its package config:

```sh
corepack pnpm exec vp run -t vite-hub#build
corepack pnpm --dir packages/vite-hub exec vp test test/console-colocated-skills.test.ts
corepack pnpm --dir packages/vite-hub run typecheck
```

Replace `vite-hub` with a manifest package name, such as `@vite-hub/agent`, and use the matching directory. Use the Vite+ target build for dependency builds; `run-package-task.mjs build --packages` builds only the selected packages. Add the following checks only when their behavior is affected:

| Change | Check from the repository root |
| --- | --- |
| Source code | `corepack pnpm exec vp run lint` and the owner package's typecheck |
| Root contracts or development tooling | `corepack pnpm exec vp test --config vitest.config.ts test/<file>.test.ts` after required builds |
| Published imports or consumer integration | `corepack pnpm exec vp run test:consumer` |
| Generated Cloudflare or Vercel output | `corepack pnpm exec vp run test:output:cloudflare` or `test:output:vercel` |
| User documentation links | `corepack pnpm exec vp run --filter vitehub-docs test:links` |
| Repository-wide impact | `corepack pnpm exec vp run verify` |

Root contracts do not include package tests. The full local gate does not replace provider runtime or browser checks. Read [CI](.github/workflows/ci.yml) for checks enabled on each event and the [live smoke workflow](.github/workflows/live-smoke.yml) for external-service requirements. Do not run live tasks without authorization.

The [Console playground](playground/console/README.md) exercises the real UI with synthetic data. It cannot prove invocation execution, persistence, or provider behavior. For a Console runtime change, also exercise the real route and runtime with a local consumer.

Report the observed user result, exact commands, failures, and unverified parts. Separate setup and infrastructure failures from product failures. Stop when the requested outcome and relevant checks pass; do not broaden testing without a new concern.

## Load relevant guidance

Use the [ViteHub skill](docs/skills/vitehub/SKILL.md) when building or debugging a consuming application. Its reference table selects guidance for Agent Definitions, Workspaces, Channels, providers, and other features. Load only the matching references. For repository changes, current source and local user docs are the contract; use the skill's installed-package checks when reproducing a consumer problem.

For package-specific contracts, read the affected package README and [user reference](docs/content/docs/reference/index.md). Do not copy those contracts into contributor instructions. Keep skill purposes separate from repository rules and from Skills loaded by product Agents.

## Design and implementation

Build complex things as simply as possible. Simple and obvious are not always the same. Accept internal machinery when it makes the public contract behave as a developer or Agent would expect.

Normal work must not expose implementation details, framework details, or compatibility history. Put shared behavior at the ViteHub boundary that owns it. Preserve ViteHub abstractions over local convenience.

Before you preserve a legacy path, search this repository and known consumers for real callers. Migrate those callers to the final contract. Delete speculative compatibility unless the task requires it.

Treat a downstream workaround as evidence of a ViteHub gap unless it is product-specific.

Every runtime feature must be inspectable through code or CLI. This includes generated state, bindings, discovered definitions, and provider output. A dashboard can help, but it must not be the only inspection path.

Familiar interfaces such as filesystems, tools, and shells are useful. Keep their contracts honest. State durability, isolation, security, persistence, cost, and production readiness explicitly.

Keep changes small. Use existing code or a suitable library before building infrastructure. Prefer inferred types that make invalid states hard to represent. Avoid cast-only wrappers. Comments should explain use or a non-obvious constraint. Measure before and after when claiming a performance improvement.

ViteHub is in active development. Breaking changes and removal of unused compatibility are welcome when they clarify the final contract. Use Better Auth as a composition reference and UnJS for host-independent behavior. Document public behavior in `docs/content/docs/` and the affected package README.

## Downstream patch loop

Use `pnpm patch` in a consuming project to prove the smallest downstream fix:

1. Patch the smallest downstream change.
2. Verify the real consumer flow.
3. Upstream the source fix with focused coverage.
4. Update the consumer to the fixed version and remove the patch.

The fix is complete when the consumer works without the patch. Retire combined patches one hunk at a time as their fixes land upstream.

## Visual and design work

- Make interface, layout, and copy changes directly. Create a mock only when I ask.
- When T3 Code is the named reference, inspect its current source and screenshots. Do not copy it from memory.
- Use Nuxt UI components when they fit. Match ViteHub's compact spacing and T3 Code's interaction patterns.
- Prefer dense layouts, small icons, minimal copy, true black in dark mode, white primary text, and few borders.
- Avoid decorative cards, pills, shadows, and subtitle rows.
- Avoid continuously repainting animations such as pulse, shimmer, blur, and spinning loaders.
- Check overflow, narrow widths, long tab lists, empty states, keyboard access, and panel resizing when they apply.
- Ask before opening a browser or starting a development server unless the task already requests it.

## Pull requests

- Do not push changes, create a pull request, or update a pull request unless I ask.
- Confirm the destination repository and check for an existing pull request before you open one.
- Rebase onto the latest `main` before opening a pull request.
- Open a real pull request, not a draft.
- Keep one concern per pull request unless I ask to combine work.
- Use the repository's conventional title style, for example `fix(workspace): preserve source grants`.
- Start the body with the problem, then explain the fix in plain language. Omit commit hashes and boilerplate sections unless they help the reviewer.
- End the body with the model and harness used.
- Interface pull requests need before and after images. Changes to motion or timing need a short video. Upload this evidence to GitHub. Do not commit pull-request-only media.
- When monitoring a pull request, inspect checks and comments newer than the last push. Verify bot findings against the source. Fix real issues and explain false positives. Separate code failures from infrastructure failures. Stay quiet when nothing changed. Stop when review bots and required checks are green on the latest commit.
- Merge only when my request gives that authority.
- Never force-push.

Pull request work belongs in a dedicated worktree. Reuse an isolated task worktree, or create one from the refreshed target base. Inspect collisions and preserve other agents' work.

Do not commit temporary plans, raw thread exports, or scratch files. Use `.agents/research/` only for durable, cited research that supports a project decision. Remove task-created temporary files and worktrees after their remote state is safe; never remove pre-existing work without authorization.
