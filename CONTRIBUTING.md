# Contributing to ViteHub

Use this guide to turn a requested behavior into a tested change. [AGENTS.md](AGENTS.md) explains the project's purpose, principles, and general rules.

## Code map

| Path | Responsibility |
| --- | --- |
| `packages/vite-hub/src/` | Framework distribution, discovery, generated output, and host integration |
| `packages/vite-hub/src/console/` | First-party inspection UI and server routes |
| `packages/agent/src/` | Agent Definitions, Drivers, Invocations, and Capabilities |
| `packages/runtime/src/` | Shared host-independent runtime contracts |
| `packages/workspace/src/`, `packages/source/src/` | File trees, access, and mounted Sources |
| Other `packages/*/src/` | Each Server Primitive or integration |
| `playground/console/` | Real Console UI with synthetic API data |
| `fixtures/`, `test/consumer/`, `test/output/` | Consumer applications and generated output proof |
| `test/multi-instance/` | One app on three Node instances against Postgres and Redis |
| `docs/` | User documentation and the first-party website |

Use these names consistently: Server Primitives, Agent Definitions, Drivers, Invocations, Capabilities, Workspaces, Sources, framework integrations, and generated host output. Runtime policy belongs in its owner package.

## Set up a checkout

Use the Node version required by `package.json`. For the full verification gate, install the Deno version in `.deno-version` with the [official Deno installation guide](https://docs.deno.com/runtime/getting_started/installation/). CI reads the same pin.

The checkout requires Node.js 22.22+ on 22.x, or 24.11 or newer, to support its development tools and Nitro. Most standalone packages retain their Node.js 22.18 minimum; Queue requires Node.js 22.19. The compatibility CI job installs dependencies on Node.js 24 before switching to 22.18 for its tests.

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

A global `vp` installation is not required. Use `corepack pnpm exec vp` after installation. Node and pnpm requirements come from `package.json`; the Deno pin comes from `.deno-version`. The current preflight checks Deno. It does not validate credentials or every provider tool.

## Start with one user outcome

Reopen the latest issue, PR, screenshot, or consumer. State the input, action, and result that will prove completion. Name adjacent behavior that must remain unchanged. Start with one real feature before changing the delivery process.

Trace only the parts the feature uses: interface or CLI, server entry, runtime, persistence, background work, and external services. For state or resource owners, cover applicable failure, abort, cancellation, timeout, cleanup, restart, and concurrent reuse behavior. A mock proves only the boundary it controls.

Keep one owner responsible for integration and completion. Record commands and interventions in the PR; do not add a separate tracking system. Separate blocking defects from optional improvements. Add process only when this work shows why it is needed.

## Verify the changed behavior

Package scripts own package-local build, test, and typecheck behavior. [`vite.config.ts`](vite.config.ts) and [`test/tasks.ts`](test/tasks.ts) define root tasks. [`test/layers.ts`](test/layers.ts) defines test discovery. Use these files when task details change; do not create a second task registry.

Start with the affected package's full `test` script so every package-owned test invocation runs, including suites with a separate configuration:

```sh
corepack pnpm --dir packages/vite-hub run test
```

For example, use `corepack pnpm --dir packages/internal run test` for `@vite-hub/internal` to include its default and Workerd suites. To run the package tests that a pull request runs, use `node test/run-package-task.mjs test --affected origin/main`. It selects the packages that the branch changes and the packages that depend on them. Add `--list` to print the selection without running it. The root package runner builds the selected packages and their dependencies once, then runs every command in these scripts after removing leading `vp run --cache -t <package>#build` commands (or the same commands without `--cache`) for builds it already completed.

The package `typecheck` script builds the package and its workspace dependencies first. It works from a fresh install without a manual build:

```sh
corepack pnpm --dir packages/vite-hub run typecheck
```

For one regression, build the package and its dependencies, then run Vitest from the package directory so it uses the package config:

```sh
corepack pnpm exec vp run --cache -t vite-hub#build && corepack pnpm --dir packages/vite-hub exec vp test test/console-colocated-skills.test.ts
```

With `--cache`, Vite+ replays package builds whose inputs did not change, so a repeat build takes about one second. Root Vitest runs only root contracts. If you give it a package test path, it stops and shows these commands. `vp check --no-fmt` is the CI lint gate. It needs no build, but it does not run TypeScript checks.

Replace `vite-hub` with a manifest package name, such as `@vite-hub/agent`, and use the matching directory. Use the Vite+ target build for dependency builds; `run-package-task.mjs build --packages` builds only the selected packages. The root `build` task builds every package in dependency order and caches each package build by the files it reads, so it rebuilds only packages whose inputs changed. `--no-cache` does not reach its nested run; run `corepack pnpm exec vp cache clean` first to force a full rebuild. Add the following checks only when their behavior is affected:

| Change | Check from the repository root |
| --- | --- |
| Source code | `corepack pnpm exec vp run lint` and the owner package's typecheck |
| Root contracts or development tooling | `corepack pnpm exec vp test --config vitest.config.ts test/<file>.test.ts` after required builds |
| Published imports or consumer integration | `corepack pnpm exec vp run test:consumer` |
| Generated Cloudflare or Vercel output | `corepack pnpm exec vp run test:output:cloudflare` or `test:output:vercel` |
| A primitive on several Node instances | `corepack pnpm exec vp run e2e:multi-instance` (needs Docker, see [its README](test/multi-instance/README.md)) |
| Behavior against a real Postgres or Redis | `corepack pnpm exec vp run test:services` with `VITEHUB_TEST_POSTGRES_URL` and `VITEHUB_TEST_REDIS_URL` set |
| User documentation links | `corepack pnpm exec vp run --filter vitehub-docs test:links` |
| Comments overlay in the page | `corepack pnpm --filter @vite-hub/comments exec playwright-core install chromium-headless-shell` once, then `corepack pnpm --filter @vite-hub/comments test:browser` (not in CI) |
| Repository-wide impact | `corepack pnpm exec vp run verify` |

A package test that needs a real Postgres or Redis reads `VITEHUB_TEST_POSTGRES_URL` or `VITEHUB_TEST_REDIS_URL` and skips when the variable is not set. The `postgres and redis tests` CI job finds these files by the variable they read and runs them against `postgres:17` and `redis:7` service containers, so a new file needs no CI change.

Package typechecks use the pinned `tsrs` Rust port of TypeScript in its default compatibility mode. The shared `test/package-typecheck.mjs` launcher retains native TypeScript 7 through the `typescript-native` alias on hosts without a `tsrs` payload, including Windows ARM64. Keep `typescript` on version 6 for Vue checks and tools that use the JavaScript compiler API, including Sandbox Task discovery. `tsrs` is experimental; check compatibility before upgrading its pinned version. Package path mappings are relative to their config file because TypeScript 7 no longer supports `baseUrl`.

Root contracts do not include package tests. The full local gate does not replace provider runtime or browser checks. Read [CI](.github/workflows/ci.yml) for checks enabled on each event and the [live smoke workflow](.github/workflows/live-smoke.yml) for external-service requirements. Do not run live tasks without authorization.

A push to `main` deploys the docs site to vitehub.dev after all repository verification jobs pass. Scheduled and manual live-smoke runs test the newest `main` commit with successful CI from the last 48 hours, and fail when there is none. The `docs-deploy` job uses the Cloudflare token of the `Production` environment. `vp run --filter vitehub-docs deploy:cloudflare` remains the manual path.

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

A check that guards a sensitive action returns a grant, and the action requires that grant. Define grants with the [runtime grant helper](packages/runtime/README.md#grants). Grants are request-scoped. Never persist a grant. `test/grant-contract.test.ts` fails on known shapes that skip this rule.

Familiar interfaces such as filesystems, tools, and shells are useful. Keep their contracts honest. State durability, isolation, security, persistence, cost, and production readiness explicitly.

Keep changes small. Use existing code or a suitable library before building infrastructure. Prefer inferred types that make invalid states hard to represent. Avoid cast-only wrappers. Comments should explain use or a non-obvious constraint. Measure before and after when claiming a performance improvement.

ViteHub is in active development. Breaking changes and removal of unused compatibility are welcome when they clarify the final contract. Use Better Auth as a composition reference and UnJS for host-independent behavior. Document public behavior in `docs/content/docs/` and the affected package README.

### Errors

Every primitive follows one error contract. `@vite-hub/runtime` owns it: `Result`, `ResultError`, and `defineErrors()`.

1. A runtime operation returns `[error, data]`. Errors before a stream starts are in the tuple; errors after it starts go into the stream.
2. Definition and config errors throw, at build time, at define time, or when an operation starts.
3. Define a small catalog with `defineErrors()`. Each code has a guessable name (`KV_INVALID_CURSOR`), a real `why`, and a real `fix`. Do not pass a free `message` as the `why`.
4. Type each method with the union of the codes it can return, and check the union in a `*.test-d.ts` file.
5. Give each code a heading on `docs/content/docs/<primitive>/limits-and-errors.md`, so `error.docs` opens it.

### Documentation structure

`docs/content/docs/` has one folder per product. Each Server Primitive folder is one docs section with its own page panel and uses the same task lanes when the product has real content for them: `index.md` (the Overview: set `layout: landing` so it renders as a landing page with a hero and page cards beside the shared navigation), `get-started.md` (the Tutorial), `configure.md` (Guides), `server-api.md` (Reference), `agent-capability.md` when the primitive has an Agent Capability, `hosts.md` (Deploy), and `limits-and-errors.md` (Operate). Create a page only when the product has real content for it. Product-specific pages such as `env/bridge.md` come after the template pages. Sidebar groups combine related tasks under Learn, Build, and Deploy and operate. Each page still follows the Diátaxis model: a Tutorial teaches a first result, a Guide completes one task, Reference describes the contract, and Concepts explain choices. Set `navigation.kind` when a page needs a lane other than the standard page id mapping. `.navigation.yml` declares the section `title`, `icon`, `order`, catalog `category`, and `related` section ids. Every docs page shows the primitive rail. Set the section `icon` to a `@vite-hub/icons` icon, such as `i-vitehub-kv`, so the rail, the sidebar, and the Console show the same icon. Draw a missing icon in `packages/icons/svg/` first. The site runs on `@vite-hub/docs` (`packages/docs`): the shell, the page layouts, search, and the agent resources live there, and `docs/nuxt.config.ts` sets the ViteHub options under `docs`. Markdown blocks that only ViteHub uses live in `docs/app/components/content/`. Pages outside `docs/content/docs/`, such as `docs/content/about.md`, render at their own path. Agent-only Capabilities live under `agents/capabilities/`. Get started, the shared architecture overview, and AI resources live under `getting-started/`. Detailed concepts live with their owner package. Framework, development, and shared reference sections are reached from Get started and the catalog. When a page moves, add its old path to `docs/modules/vitehub-docs/redirects.ts` and update inbound links; `corepack pnpm exec vp run --filter vitehub-docs test:links` checks every internal link and anchor.

### Writing docs pages

Write for a developer who has never used ViteHub. Explain a term the first time you use it, in one plain sentence. "A Schedule is server code that runs at set times" is better than "a Static Schedule Definition".

- Start a tutorial with what the reader builds and what they need. Then give the steps. End with what happens in production and with links to the next pages.
- Write one instruction per sentence, in the imperative: "Create `server/schedules/daily-report.ts`." Do not explain a tool, such as ESM or `pnpm pkg`, unless the step fails without it.
- After a code block, explain only the lines that the reader must understand, as a short list. Put the rest on the Configure or Server API page.
- Show the real output of each command that the reader runs. Copy it from a real run.
- Use comark-ui blocks, not hand-made Markdown. Write install commands once as a `bash pm` fence, so the reader picks npm, pnpm, yarn, or bun. Use `> [!NOTE]` for the one thing the reader must not miss, `::tabs` for Vite and Nuxt versions of a step, `::details` for text most readers skip, and `::card-group` for the next pages.

### Code blocks

CI type-checks every `ts` block in `docs/content/docs/` and in the package READMEs against the built packages. Run the same package build and check as CI:

```sh
corepack pnpm exec vp run build
corepack pnpm exec vp run --filter vitehub-docs test:snippets
```

Write a block as a file that works when an Agent copies it: include its imports. The blocks of one page form one project, so a block labeled `[server/db/schema.ts]` can be imported by the other blocks of that page. When a page shows a file several times, an import gets the last full version of it above the importing block. If no full version appears above the importer, it uses the first full version on the page so the blocks can still be copied together as one project. The check also writes the `.vitehub` types that ViteHub generates for the Definitions that a page shows, such as `[server/queues/welcome-email.ts]` or `[server/databases/default.ts]`, the Auth plugins of `[server/auth.ts]`, and the Env values that `[vite.config.ts]` or `[nuxt.config.ts]` declares. A page that calls a Definition by name, such as `runQueue('welcome-email')` or `useDatabase('default')`, must show that Definition. Mark a block that is an excerpt of a larger file with `fragment` after its label, for example ```` ```ts [server/agents/support.ts] fragment ````. A block that shows a type error on purpose, such as the invalid example of a Doctor rule, names the errors it must fail with: ```` ```ts [server/auth.ts] fails=TS2769 ````. The check fails when such a block passes or fails with other errors. The site does not show either marker. `docs/scripts/check-snippets.baseline.json` lists blocks that are correct but fail because a package type is wrong. Fix the type and remove its entry; the check fails when a listed block passes, its code or label changes, or its diagnostics change.

Run `corepack pnpm --dir docs run test:snippets --update-baseline` to remove fixed entries. The command leaves the baseline unchanged and fails if it finds a new or changed failure.

### Content for agents

Agents get each page as raw Markdown at `/raw/<page>.md`, in llms-full.txt, and through the docs MCP server. They get everything a human sees, plus agent-only blocks:

```md
::agent-only
Run `pnpm vitehub schedule run-runtime weekday-report` to start the run that the Console button starts.
::
```

The site renders nothing for `::agent-only`. Use it only for content that helps a coding agent and distracts a human: CLI or code equivalents of Console or UI steps, host-specific mistakes that agents make, and internals that an agent needs to debug a failure. Add a block when a real agent run or the agent docs eval shows the failure, not before. Put full option lists, edge cases, and long examples in visible content, such as `::collapsible` or a reference page, so that humans review them too. Agents get `::collapsible` content inline.

A block with `skill="<name>"` is also the source of `docs/skills/vitehub/references/primitives/<name>.md`. Edit the block, not the generated file, then run `corepack pnpm --dir docs exec vp test test/agent-resources.test.ts -u`.

Rules that apply to every task belong in `agentDiscovery.llms.details` in `docs/nuxt.config.ts`, which prints them at the top of llms.txt. To measure whether agent-only content helps, run the [agent docs eval](docs/evals/agent-docs/README.md).

### Site parity

When a change can alter what vitehub.dev serves without a content edit, such as how `@vite-hub/docs` loads pages, prove that no page changed. `docs/scripts/parity.mjs` fetches every URL the site serves: each page as HTML, as negotiated Markdown, as its `.md` twin, at `/raw`, and as page JSON, and through the MCP `get-page` tool. It also fetches the sitemaps, llms.txt, llms-full.txt, `search.json`, the skills, and the links it finds in them. It removes build hashes and timestamps, and it keeps text, headings, links, and head tags. Record the base, then the change, from the same kind of build:

```sh
# On the base commit, then again on your branch
corepack pnpm exec vp run --cache -t vite-hub#build && corepack pnpm exec vp run docs:build
cd docs && ../node_modules/.bin/wrangler dev --config .output/server/wrangler.json --port 4791 &
node docs/scripts/parity.mjs crawl http://127.0.0.1:4791 /tmp/parity/base --site https://vitehub.dev
node docs/scripts/parity.mjs compare /tmp/parity/base /tmp/parity/branch
```

`compare` lists added, removed, and changed URLs with the changed lines, and exits with 1 when there is a difference. The snapshots are large (about 150 MB of bodies), so keep them out of the repository. `crawl https://vitehub.dev` records the live site in the same format.

`crawl` and `compare` also exit with 1 when requests fail after retries or the request limit skips URLs. These snapshots have `complete: false` and are only for diagnosis. Fix the request failure or increase `--limit` (default: 20000), then crawl again. HTTP responses such as 404s remain comparable. Record both snapshots again if they predate completeness tracking.

### Worker bench

When a change can make the docs Worker bigger or slower, such as how `@vite-hub/docs` loads pages, measure the built Worker before and after. `docs/scripts/bench-worker.mjs` reports:

- Worker bytes from `wrangler deploy --dry-run --outdir`, and aggregate gzip bytes from Wrangler's rounded upload report. Per-module gzip sizes are separate diagnostics.
- Start time: how long a fresh `workerd` takes to emit its control-pipe `listen` event after module compilation and top-level initialization, minus the same for an empty Worker. No request is sent.
- Cold latency: a fresh `wrangler dev` per sample, and the first request for each of 20 fixed pages.
- Warm latency: one `wrangler dev`, two warmup rounds, then ten measured rounds.
- Memory: the RSS that the loaded Worker adds to `workerd`, and the peak RSS of the `wrangler dev` `workerd`. These are process numbers, not the isolate heap that the 128 MB limit counts.

```sh
corepack pnpm exec vp run --cache -t vite-hub#build && corepack pnpm exec vp run docs:build
node docs/scripts/bench-worker.mjs run --out /tmp/bench/base.json
# Build your branch the same way, then
node docs/scripts/bench-worker.mjs run --out /tmp/bench/branch.json
node docs/scripts/bench-worker.mjs compare /tmp/bench/base.json /tmp/bench/branch.json
```

A run takes about two minutes and uses port 4813 (`--port` changes it). `compare` prints ratios and exits with 1 when cold p95 is more than 1.5 times the base. On a busy machine, two runs of the same build gave cold p95 values 1.8 times apart, so run each side twice and compare the per-page cold p50 values, which stayed within 15% for pages above 10 ms. Start time and bytes are stable.

## Downstream patch loop

Use `pnpm patch` in a consuming project to prove the smallest downstream fix:

1. Patch the smallest downstream change.
2. Verify the real consumer flow.
3. Upstream the source fix with focused coverage.
4. Update the consumer to the fixed version and remove the patch.

The fix is complete when the consumer works without the patch. Retire combined patches one hunk at a time as their fixes land upstream.

## Visual and design work

- Make interface, layout, and copy changes directly. Create a mock only when the task asks for one.
- When T3 Code is the named reference, inspect its current source and screenshots. Do not copy it from memory.
- Use Nuxt UI components when they fit. Match ViteHub's compact spacing and T3 Code's interaction patterns.
- Prefer dense layouts, small icons, minimal copy, true black in dark mode, white primary text, and few borders.
- Avoid decorative cards, pills, shadows, and subtitle rows.
- Avoid continuously repainting animations such as pulse, shimmer, blur, and spinning loaders.
- Check overflow, narrow widths, long tab lists, empty states, keyboard access, and panel resizing when they apply.
- Check an interface change in a browser before you report it, at the widths and themes it affects.

## Releases

ViteHub publishes all public packages at one version. The checked-in root and public package versions are the release baseline. A push to `main` uses conventional commits since the latest `v*` tag to open or update a draft `release/vX.Y.Z` PR. The required checks run on that release branch even though GitHub creates the PR with `GITHUB_TOKEN`.

Review the version, package changes, CI result, and release notes before merging the release PR. After merge, the release workflow verifies the exact merge commit, creates its tag, and dispatches `release.yml` on that tag. The existing package workflow builds and tests immutable tarballs, publishes to npm, verifies the registry, and then creates the GitHub release. A manual dispatch on a branch remains a dry run. A manual dispatch on a `v*` tag resumes publication for that tag.

If merge verification fails permanently before a tag is created, merge a correction PR directly after the failed release merge. Then manually run **prepare release** on `main` with `recover_failed_release` enabled and its `recovery_pr` number. Recovery runs the full gate and tags that reviewed correction commit with the original unpublished version, even if later commits have reached `main`. Use the ordinary rerun path for transient failures.

An organization owner must allow GitHub Actions to create and approve pull requests in the organization Actions settings. Repository administrators must then enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**. Without both settings, uppt pushes the release branch but cannot open the release PR. The `npm-release` environment must restrict deployments to `v*` tags and require the chosen reviewers before the first automated release. Each public npm package must trust `vite-hub/vitehub` with workflow `release.yml` and environment `npm-release`. npm adds a trusted publisher only to a package that already exists, so publish a new package once by hand before the first release that includes it. Nuxt Better Auth and Vite Doctor use npm staged publishing; ViteHub continues its current direct trusted publication until staged publishing and its approval flow are configured for every public package.

## Pull requests

- A request to fix or build something includes a pushed branch and an open pull request, unless the request says to explore, review, plan, or hold.
- Confirm the destination repository and check for an existing pull request before you open one.
- Rebase onto the latest `main` before opening a pull request.
- Open a real pull request, not a draft.
- Keep one concern per pull request unless the task asks to combine work.
- Use the repository's conventional title style, for example `fix(workspace): preserve source grants`.
- Start the body with the problem, then explain the fix in plain language. Omit commit hashes and boilerplate sections unless they help the reviewer.
- End the body with the model and harness used.
- Interface pull requests need before and after images. Changes to motion or timing need a short video. Attach this evidence to the pull request, as an upload or a linked page. Do not commit pull-request-only media.
- When monitoring a pull request, inspect checks and comments newer than the last push. Verify bot findings against the source. Fix real issues and explain false positives. Separate code failures from infrastructure failures. Stay quiet when nothing changed. Stop when review bots and required checks are green on the latest commit.
- Merge only when the task gives that authority.
- Force-push only when the task grants it, only to your own task branch, and only with `--force-with-lease`.

Pull request work belongs in a dedicated worktree. Reuse an isolated task worktree, or create one from the refreshed target base. Inspect collisions and preserve other agents' work.

Before you open a pull request that removes public API, commit the change and run `vp run consumers:check`. It finds the package subpaths and exported names that the branch removes compared with `origin/main`, and searches your own projects for them, in the working tree and on the default branch. Add `--name <text>` for what the diff cannot find, such as a config key, a CLI flag, an env var, or a diagnostic code. The list of projects stays on your machine: put one path per line in `~/.config/vitehub/consumer-roots`, or set `VITEHUB_CONSUMER_ROOTS`. The check fails with the project, file, and line of each use. A hit inside `patches/` does not fail, but read the patch: a patch that edits the removed feature is a use. CI does not run this check, because it has no consumer checkouts.

When an entry loses its default export, the check searches its module specifier, since default imports can use any local name. Missing roots or failed searches exit 2. Fix the setup and run the check again.

Do not commit temporary plans, raw thread exports, or scratch files. Keep durable, cited research in the issue or pull request that supports a project decision. Remove task-created temporary files and worktrees after their remote state is safe; never remove pre-existing work without authorization.
