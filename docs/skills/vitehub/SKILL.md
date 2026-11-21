---
name: vitehub
description: Build, change, and debug ViteHub apps. Use in an app with ViteHub before you write auth, migration, storage, realtime, skill, logging, rate limit, env, or deploy code, and for server primitives and Runtime Helpers, Agent Definitions, Provider Output, hosts, and deployment.
---

# ViteHub

Use one proof loop: orient, look up the built-in, route, inspect the contract, build, and prove. Exact package exports, installed types, and current raw docs outrank remembered or project-example syntax.

## 1. Orient

- In an existing project, run `pnpm vitehub status --json` first. It parses the config without running it, so it works on a broken config. It names the framework, the host, each feature as `on`, `off`, or `unknown`, the missing packages with their fix, and the host link. In an empty folder, start with `pnpm dlx vite-hub catalog --json`, then create the project with `pnpm dlx vite-hub init`. Where a project exists but `vite-hub` is not installed yet, run `pnpm dlx vite-hub status --json`. No npm package is named `vitehub`, so `npx vitehub` fails. Use the package name `vite-hub`.
- Run `pnpm vitehub catalog --json` before you choose a feature or a host. Where `vite-hub` is not installed yet, use `pnpm dlx vite-hub catalog --json`. It lists each feature key, its packages, and how each host supports it (`native`, `explicit`, or `unsupported`), from the same catalog that the build checks. See [Read a project without loading it](https://vitehub.dev/raw/docs/cli/project.md#read-a-project-without-loading-it).
- Then read only what the two commands do not answer: the lockfile, the server entry, nearby project instructions, and config parts that `status` reports as `unknown` or `manual`.
- Identify installed ViteHub packages and versions, package manager, framework, host target, and requested outcome.
- Open `https://vitehub.dev/llms.txt`, then select the smallest raw Markdown page covering the primary behavior. Links inside references are selection menus; do not open every linked page.

Orientation is complete when the current setup, target outcome, host boundary, and first docs URL are named.

## 2. Look up the built-in first

ViteHub ships code that apps often write by hand. Before you write or change auth, migration, storage, realtime, skill, logging, rate limit, env, or deploy code, find the problem in this table. Also read the app code that already does the job: a built-in can ship after the app wrote its own version.

| Problem | Built-in | Docs |
| --- | --- | --- |
| Migrations: a `drizzle.config.ts`, `drizzle-kit` scripts, or SQL files written by hand | `vitehub database generate`, then `vitehub database migrate`. `vitehub database up` converts an old folder once | [database/configure](https://vitehub.dev/raw/docs/database/configure.md#apply-migrations) |
| Apply migrations when the server starts or deploys: a custom migrator, or `wrangler d1 migrations apply` in a script | `database.migrateOnStart` on Node, `database.migrateOnDeploy` on Cloudflare, `ensureMigrations()` in a task or test | [database/configure](https://vitehub.dev/raw/docs/database/configure.md#migrate-when-the-server-starts) |
| Copy the SQLite file before migrations, such as with `VACUUM INTO` | `database.migrateOnStart: { backup: true }` | [database/configure](https://vitehub.dev/raw/docs/database/configure.md#back-up-sqlite-before-migrations) |
| Dump a database to a SQL file | `vitehub database export` | [cli/primitives](https://vitehub.dev/raw/docs/cli/primitives.md) |
| Split a long `inArray()` list or a multi-row insert for the D1 parameter limit | `chunkParameters()` from `vite-hub/database` | [database/server-api](https://vitehub.dev/raw/docs/database/server-api.md#stay-under-the-bound-parameter-limit) |
| Run a webhook or a retried request once per key | `withIdempotency()` from `vite-hub/database` | [database/server-api](https://vitehub.dev/raw/docs/database/server-api.md#run-work-once-for-a-key) |
| Let one runner at a time do a job, such as a get-then-set flag on a storage key | `kv.lock(key, { ttl }).run()` from `vite-hub/kv` | [kv/server-api](https://vitehub.dev/raw/docs/kv/server-api.md#locks) |
| Sign people in from the headers of oauth2-proxy (`x-auth-request-*`), Cloudflare Access, or Tailscale Serve | `forwardAuth()` from `vite-hub/auth/forward` | [auth/configure](https://vitehub.dev/raw/docs/auth/configure.md#sign-in-through-a-trusted-proxy) |
| Turn skills on and off while the app runs, such as with a settings table | `skillSettings()` from `vite-hub/skills` | [console/skills](https://vitehub.dev/raw/docs/console/skills.md#turn-skills-on-and-off) |
| Presence or cursors in a Realtime room that has no shared document | `defineRealtime({ document: false })` | [realtime/server-api](https://vitehub.dev/raw/docs/realtime/server-api.md#presence-without-an-editor) |
| Limit requests per user, IP, or key | `requireRateLimit(event, id, options)` from `vite-hub/rate-limit` | [rate-limit/server-api](https://vitehub.dev/raw/docs/rate-limit/server-api.md) |
| A same-origin check for writes, a request body limit, or security headers | `sameOriginWrites: true` and `security` with `maxBodySize` in `vitehub()` | [frameworks-hosts/production](https://vitehub.dev/raw/docs/frameworks-hosts/production.md#add-security-headers-and-a-body-limit) |
| Read and check `process.env` values | `vitehub({ env })` and `useServerEnv()` from `vite-hub/env` | [env/configure](https://vitehub.dev/raw/docs/env/configure.md) |
| A logger or a log event per request | `vitehub({ logs })` with Evlog | [logs/configure](https://vitehub.dev/raw/docs/logs/configure.md) |
| Deploy scripts: `wrangler deploy --secrets-file`, or creating host resources by hand | `vitehub deploy`, with `--push-env` for env values | [cli/project](https://vitehub.dev/raw/docs/cli/project.md#deploy-from-your-machine) |
| Move ViteHub packages to a new version | `vitehub update` | [cli/project](https://vitehub.dev/raw/docs/cli/project.md#update-vitehub-packages) |

When a row matches, use the built-in and delete the app's own version in the same change. When no row matches, search `https://vitehub.dev/llms.txt` for the problem before you write the code.

This step is complete when each piece of planned code is a built-in, or you can name the docs page that shows ViteHub has none.

## 3. Route before code

Choose one primary lane. Server Primitives serve application behavior through Vite Integrations and Runtime Helpers. Agents serve model-backed, provider-backed, or custom-run behavior through Agent Definitions; they may compose Server Primitives without changing the primary lane.

Read only the references whose conditions match, but read them before writing code:

| Task condition                                                                                                                                   | Required reference                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| New project, uncertain file layout, or cross-feature composition                                                                                 | [Project shapes](references/project-shapes.md)                                         |
| Released or `pkg.pr.new` installation, upgrade, or package mismatch                                                                              | [Installed and preview contracts](references/preview-contract.md)                      |
| Choosing between Server Primitives                                                                                                               | [Server Primitives](references/server-primitives.md)                                   |
| Auth, sessions, or route protection                                                                                                              | [Auth](references/primitives/auth.md)                                                  |
| Blob uploads, direct uploads to storage, copies, or object storage                                                                               | [Blob](references/primitives/blob.md)                                                  |
| Browser sessions or remote browser actions                                                                                                       | [Browser](references/primitives/browser.md)                                            |
| Outbound application message delivery                                                                                                            | [Channels](references/primitives/channels.md)                                          |
| OAuth or provider account access                                                                                                                 | [Connections](references/primitives/connections.md)                                    |
| Comark content, Markdown, or content queries                                                                                                     | [Content](references/primitives/content.md)                                            |
| Relational data, Drizzle, Postgres replicas, seeds, or SQL from the CLI                                                                          | [Database](references/primitives/database.md)                                          |
| Email or Markdown email templates                                                                                                                | [Email](references/primitives/email.md)                                                |
| Public, server, secret, or provider-backed values                                                                                                | [Env](references/primitives/env.md)                                                    |
| KV values, flags, cursors, short-lived state, or a lock that runs a job once                                                                     | [KV](references/primitives/kv.md)                                                      |
| Queue jobs and consumers                                                                                                                         | [Queue](references/primitives/queue.md)                                                |
| Atomic request budgets                                                                                                                           | [Rate Limit](references/primitives/rate-limit.md)                                      |
| Realtime collaboration                                                                                                                           | [Realtime](references/primitives/realtime.md)                                          |
| Isolated provider-backed task runs                                                                                                               | [Sandbox Tasks](references/primitives/sandbox-task.md)                                 |
| Static cron schedules                                                                                                                            | [Schedule](references/primitives/schedule.md)                                          |
| Bounded shell commands                                                                                                                           | [Shell](references/primitives/shell.md)                                                |
| Read-only external files or resources                                                                                                            | [Source](references/primitives/source.md)                                              |
| Durable long-running orchestration                                                                                                               | [Workflow](references/primitives/workflow.md)                                          |
| Persistent files, Sources, snapshots, or write-back                                                                                              | [Workspace](references/primitives/workspace.md)                                        |
| Trusted-host or provider execution sessions                                                                                                      | [Sandboxes](references/primitives/sandbox.md)                                          |
| Nitro cache storage, cache tags, or invalidation                                                                                                 | [Cache](references/primitives/cache.md)                                                |
| Markdown rendering with bindings                                                                                                                 | [Markdown Templates](references/primitives/markdown-template.md)                       |
| Modify an existing framework integration; add Nitro or Nuxt; use generated types; configure a provider; or diagnose a framework-specific failure | [Framework composition](references/framework-composition.md)                           |
| Agent Definition, Agent Driver, Agent Invocation, instructions, output, hooks, or Evals                                                          | [Agent Definitions and Drivers](references/agent-definitions.md)                       |
| Workspace, Source, access scope, mounted files, or write-back                                                                                    | [Workspaces, Sources, and access](references/workspaces-sources-access.md)             |
| Agent Channel, Trigger, webhook admission, concurrency, or Agent delivery                                                                        | [Channels and Triggers](references/channels-triggers.md)                               |
| Capability, tool, secret, rate limit, telemetry, or other granted authority                                                                      | [Capabilities and authority](references/capabilities-authority.md)                     |
| Schedule, Workflow, orchestration retry, idempotency, or terminal state                                                                          | [Schedules, Workflows, and Invocations](references/schedules-workflows-invocations.md) |
| Sandbox, trusted host, isolation, required command, host link, deploy, Console link, or deployed version                                         | [Sandboxes and hosts](references/sandboxes-hosts.md)                                   |
| Bundle size, startup cost, host size limits, why a package is in the output, or whether a change made the bundle smaller                         | [Bundle size and startup cost](references/bundle.md)                                   |
| A proof has failed, generated state disagrees, or a runtime/host failure needs diagnosis                                                         | [Proof and recovery](references/proof-recovery.md)                                     |
| Looking for a complete public application pattern                                                                                                | [Project patterns](references/project-patterns.md)                                     |

Routing is complete when every requested behavior has one primary lane and every matching reference has been read. Start with the smallest matching set, then add a cross-cutting reference when the task spans lanes.

## 4. Inspect the installed contract

- Read each installed package's `package.json`, exports, relevant types, and generated declarations before writing imports or options.
- For a fresh application, create it with `vitehub init` (see [Project shapes](references/project-shapes.md)), then use the root integration plus feature subpaths. Opt-in features such as Agent, Auth, Database, Schedule, Workspace, Realtime, Content, and Comments also need their owner package next to `vite-hub`. `vitehub add` installs it, `vitehub status` lists any that is missing, and the build error names it. Use other direct owner packages only for a focused library, an unexported advanced subpath, or an installed older contract.
- When docs, examples, and installed artifacts disagree, implement the installed artifacts and record the mismatch. Treat project examples as patterns whose imports must be revalidated.

Contract inspection is complete when every planned package, import, option, generated path, and runtime entry exists in the installed graph; no syntax is inferred only from memory.

## 5. Build the coherent file set

Before editing, map every requested behavior to:

| Behavior | Package owner | Source file | Runtime path | Authority or persistence | Proof |
| -------- | ------------- | ----------- | ------------ | ------------------------ | ----- |

Then implement the smallest coherent set: manifest and lockfile, framework integration, discovered Definition where needed, application or orchestration entrypoint, and proof surface. Keep application authority in application code; grant an Agent access only through visible Capabilities, Workspace rules, Sources, or Channels.

Turn features on with `vitehub add <feature>`, not by editing `vitehub({...})` by hand. It checks the host against the catalog, installs the owner packages, creates requested starter files, and edits the config last. Package installs are not rolled back: a failed install can leave the manifest and lockfile changed without enabling the feature. See [Add a feature](https://vitehub.dev/raw/docs/cli/project.md#add-a-feature).

- Run `--dry-run` first and read the diff, then apply with `--yes`. Without a terminal, `add` writes nothing until it gets `--yes`.
- Pass `--name <name>` for a starter Definition, such as `server/queues/<name>.ts`. It never overwrites a file.
- Pass provider options as `--option key=value`, such as `--option email.driver=resend`.
- Follow the exit code. `0`: done or unchanged. `2`: input is needed; run the `rerun` command it prints, or supply the options listed in `missing` with their `choices`. `3`: a conflict; read the diagnostic code. For `SETUP_FILE_EXISTS`, choose another `--name`, or edit the existing file by hand and then rerun `vitehub add <feature> --yes` without `--name`, keeping the required `--option` values, to install packages and enable the feature. For `SETUP_CONFIG_MANUAL`, paste the printed `snippet` into the `vitehub()` options by hand. For an unsupported feature, choose another host or report the boundary, because a hand-written key does not give the host the feature. `4` (`SETUP_STALE_PLAN`): the config changed during installation; discard the plan and rerun against the current config.
- Turn a feature off with `vitehub remove <feature>`. Run `--dry-run` first and read the plan, then apply with `--yes`. It deletes the config key, deletes starter files that are still unchanged, and uninstalls packages that nothing else uses. Exit `3` means another feature implies it (`SETUP_FEATURE_IMPLIED`, see `impliedBy`) or the app still uses it (`SETUP_FEATURE_IN_USE`): `references` lists each file and line, including starter files you edited. Delete or move those files and run it again. Pass `--force` only when the developer wants the feature off and the files kept. `remove` never deletes host resources, local data, or the host link; `nextSteps` names the host resources to delete by hand. See [Remove a feature](https://vitehub.dev/raw/docs/cli/project.md#remove-a-feature).

Building is complete when every requested behavior has an implemented row and no placeholder, unused integration, implicit authority, or unowned persistence remains.

## 6. Prove and repair

- Run the narrow typecheck or package test nearest the change, then the relevant build.
- Run Vite Doctor with the ViteHub rules. The `vite-doctor` CLI does not read `vite.config.ts`, so register the extension in a config file. Name the pack in `extends`, or its rules do not run. `auto` keeps the other packs:

  ```ts [doctor.config.ts]
  import { defineDoctorConfig } from 'vite-doctor/config'
  import vitehub from 'vite-hub/doctor'

  export default defineDoctorConfig({ extensions: [vitehub], extends: ['auto', 'vitehub/recommended'] })
  ```

  Run `pnpm vite-doctor . --config doctor.config.ts` and fix each `VHUB` finding. See [Doctor rules](https://vitehub.dev/raw/docs/reference/doctor-rules.md).
- Prove the actual lane: execute the Runtime Helper, perform an Agent Invocation, exercise the webhook or schedule, or inspect generated Provider Output.
- On failure, return to installed exports/types, `.vitehub` generated state, the selected raw docs page, and [Proof and recovery](references/proof-recovery.md). Repair the cause and rerun the same proof.

The task is complete when every behavior row has an observed result, or a precise source-backed unsupported boundary, and Doctor reports no `VHUB` finding. Report commands and observations, docs URLs, installed ViteHub versions or preview commit, contract mismatches, and host limitations.
