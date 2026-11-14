---
title: Project commands
description: Create a ViteHub app, read its features without loading the config, and turn features on and off with the vitehub CLI.
navigation.title: Project
navigation.order: 2
navigation.group: Start
icon: i-lucide-folder-cog
---

Project commands create your app and turn its features on and off. They parse `vite.config.*` or `nuxt.config.*` instead of running it, so they work before the app starts and when the config throws. Each error code links to its page in the [CLI diagnostics](/docs/cli/diagnostics).

## Create a project

`vitehub init` creates a ViteHub app in a folder, or sets up the Vite or Nuxt app that is already there. It runs from the `vite-hub` package, so you install nothing first.

```bash [Terminal]
pnpm dlx vite-hub init my-app --host cloudflare --features kv,queue --yes
pnpm dlx vite-hub init my-app --host vercel --features email --option email.driver=resend --yes --json
```

A new or empty folder gets the starter app from [Installation](/docs/getting-started/installation): `package.json`, `vite.config.ts` with `vitehub({ host })`, `tsconfig.json`, `server/api/health.get.ts`, and a `.gitignore`. A folder with a Vite or Nuxt app keeps its files, and `init` registers `vitehub()` or the Nuxt module in its config.

| Flag | What it does |
| --- | --- |
| `--host <host>` | `cloudflare`, `vercel`, `netlify`, `deno`, or `node`. It becomes `host`. |
| `--features <ids>` | Feature ids separated by commas, as `vitehub catalog` lists them. `init` plans them with `vitehub add`, so an unsupported feature stops it before any file is written. |
| `--option <feature.key=value>` | A feature option, such as `email.driver=resend`. Repeat it for more. |
| `--framework vite\|nuxt` | The default is `vite`. |
| `--pm pnpm\|npm\|yarn\|bun` | The default is the package manager the folder uses, else the one that runs the command, else pnpm. |
| `--no-install`, `--dry-run` | Skip the install (`nextSteps` gives the command), or print the plan and write nothing. |
| `--yes` | Apply the plan. Without a terminal, a missing input exits with `2`, names the flag, and gives `missing` and `rerun`. |

For Nuxt, `init` runs a pinned `nuxi init` and starter on the `5x` nightly channel, then adds the `vite-hub/nuxt` module, and an existing app must declare a known Nuxt 5 version. `init` also writes the command that recreates the stack into `README.md`, between `<!-- vitehub:stack -->` and `<!-- /vitehub:stack -->`, and `vitehub status --json` returns it as `stack.command`. A second run of the same command changes nothing.

These errors exit with `3`:

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_INIT_DIR_NOT_EMPTY`](/docs/cli/diagnostics/setup_init_dir_not_empty) | The folder has files but no Vite or Nuxt app. ViteHub never overwrites a file. | Choose a new or empty folder. |
| [`SETUP_INIT_FRAMEWORK_MISMATCH`](/docs/cli/diagnostics/setup_init_framework_mismatch) | `--framework` differs from the app in the folder. | Pass the framework of the app, or choose another folder. |
| [`SETUP_INIT_HOST_MIGRATION`](/docs/cli/diagnostics/setup_init_host_migration) | A ViteHub stack with enabled features is on another host. Nothing is installed or written. | Keep the current host, or migrate the feature options, providers, and Definitions by hand first. |
| [`SETUP_INIT_NUXT_VERSION`](/docs/cli/diagnostics/setup_init_nuxt_version) | The Nuxt app does not declare a known Nuxt 5 version, for example it uses a tag. Files that the command scaffolded stay. | Set `nuxt` to a Nuxt 5 version and run `init` again. |

## Read a project without loading it

`vitehub catalog` shows what each host supports, and `vitehub status` shows what your project has and still needs.

```bash [Terminal]
pnpm vitehub catalog --json
pnpm vitehub status --json
```

`catalog` lists every feature key of `vitehub({...})`, the packages it needs, and how each host supports it: `native`, `explicit` (an option chooses the provider), or `unsupported`. It needs no project. `status` reads the config in the current folder:

| Field | What it holds |
| --- | --- |
| `framework` | `vite`, `nuxt`, or `none`, from the config files and the dependencies. |
| `config` | The file and the config form, or `manual` with the reason when the options are not an object literal. |
| `host` | The configured `host`, else the one `detectHost()` reads from the environment, else `node`, with `source` saying which. A dynamic host or config reports `name: "unknown"` and support `level: "unknown"`. |
| `live` | The deployment that receives production traffic, and how many commits it is `behind` and `ahead` of HEAD. See [List deployments](/docs/cli/deploy#list-deployments). |
| `features` | Each feature as `on`, `off`, or `unknown` (an expression, or a key a spread overrides), with the reason `config`, `default`, or `implied`. An enabled feature lists `missingPackages` and a `fix`. |
| `checkouts` | With `vitehub.lock`, each checkout folder with its local changes and conflicts. See [Work on Workspace files in a local folder](/docs/cli/content#work-on-workspace-files-in-a-local-folder). |

With `--json`, a project command prints one JSON document, `{ "schemaVersion": 1, ... }`, and a failure prints `{ "schemaVersion": 1, "error": { "code", "message", "why", "fix", "docs" } }`. The exit code is `0` when the command is done, `1` for an error, `2` when input is needed, `3` for an unsupported or conflicting change, and `4` for a stale plan.

## Add a feature

`vitehub add` turns features on. It installs the owner packages, writes the starter files, and edits the config last, so a failed install leaves the config alone.

```bash [Terminal]
pnpm vitehub add kv queue --dry-run
pnpm vitehub add queue --name welcome-email --yes
pnpm vitehub add email --option email.driver=resend --yes --json
```

| Flag | What it does |
| --- | --- |
| `--dry-run` | Print the diff, or the plan with `--json`, and write nothing. |
| `--yes` | Apply the plan. Without it, a terminal shows the diff and asks. Without a terminal, or with `--json`, the command exits with `2` and a `rerun` that includes `--yes`. |
| `--no-install` | Skip the install. The plan still lists the packages and the command. |
| `--name <name>` | Create a starter Definition, such as `server/queues/<name>.ts`, for Agent, Database, Queue, Realtime, Schedule, and Workflow. Nuxt needs literal `rootDir` and `serverDir`. It never overwrites a file. |
| `--option <key=value>` | Set a feature option. Dotted keys make nested objects, and with one feature the feature name is optional. |

`add` sets `<feature>: true`, or the object from `--option`, and a feature that is already on prints `"status": "unchanged"`. Features it turns on as well, such as Workflow for Agent, are listed in `implied`. A feature that requires Database turns Database on, so on Netlify or Deno `add comments` needs `--option database.connection.url=libsql://your-host`.

The host decides what `add` accepts. An unsupported feature exits with `3`. A host that needs an explicit provider, such as Email on Vercel, exits with `2` and lists the option in `missing` with its `choices`, and when ViteHub can choose the values, `rerun` succeeds as it is. Node Schedules need `--option schedule.runtime.driver=process`, or `schedule.providerOutput=false` when you wake them yourself. A provider option such as `workflow.provider=openworkflow` or `blob.driver=s3` adds its packages to the install.

::note
Some host defaults build and run but keep state in one process. Workspace on Vercel, for example, keeps files in memory until `BLOB_READ_WRITE_TOKEN` is set. `nextSteps` names each one with the option that selects a durable provider.
::

`add console` sets `console: true`, so the app accepts only [signed calls](/docs/console/signed-requests). Add `--option console.authorize=server/console-authorize.ts` to limit who may use which section, or `console.auth=false` to accept unsigned calls in development. Console does not turn on Comments or Database.

`add observability` registers Evlog. `observability.service=<name>` adds Agent telemetry for Agents that Nitro hosts and installs `@vite-hub/agent`, PostHog installs `posthog-node` and turns on Server Env, and `observability.logs.source=./server/logs.ts` connects an existing production log source. Papercut reports need Agent and Console, so the command asks for their provider inputs first. A Realtime starter turns on Workspace, and its next steps name the Definition to add. A pkg.pr.new preview of the CLI installs ViteHub packages from the same preview.

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_FEATURE_UNSUPPORTED`](/docs/cli/diagnostics/setup_feature_unsupported) | The host cannot provide the feature. | Run `vitehub catalog` to see which hosts can, or change `host`. |
| [`SETUP_INPUT_NEEDED`](/docs/cli/diagnostics/setup_input_needed) | A feature name or provider option is missing. `missing` lists the fields. | Run `rerun`, which works when ViteHub can choose a value. |
| [`SETUP_CONFIG_MANUAL`](/docs/cli/diagnostics/setup_config_manual) | There is no `vitehub()` call, there are two, or the options are not an object literal. | Paste the keys from the error, or `snippet` in the JSON, into the `vitehub()` options. |
| [`SETUP_FILE_EXISTS`](/docs/cli/diagnostics/setup_file_exists) | A starter file exists with other content, or another file defines the same Definition, such as `src/database.ts` or `src/<name>.queue.ts`. | Choose another `--name`, or edit the file by hand. |
| [`SETUP_SERVER_DIR_MANUAL`](/docs/cli/diagnostics/setup_server_dir_manual) | Nuxt's server directory needs the config to run, because `serverDir` is an expression or the app uses layers. | Create the Definition there and rerun without `--name`, or use literal directory options without layers. |
| [`SETUP_INSTALL_FAILED`](/docs/cli/diagnostics/setup_install_failed) | The package manager failed. No starter or config file was written, but manifests and lockfiles may have changed. | Run the install command by hand to see the error. |
| [`SETUP_STALE_PLAN`](/docs/cli/diagnostics/setup_stale_plan) | The config changed between the plan and the write. | Run the command again. |
| [`SETUP_PLAN_UNKNOWN`](/docs/cli/diagnostics/setup_plan_unknown) | The dev Setup page applied an unknown plan id. A plan applies once, and a restart drops all plans. | Plan the change again. |
| [`SETUP_NOT_A_PROJECT`](/docs/cli/diagnostics/setup_not_a_project) | The folder has no `package.json`, `vite.config.*`, or `nuxt.config.*`. | Run the command in your app's folder. |
| [`SETUP_CONFIG_NOT_LITERAL`](/docs/cli/diagnostics/setup_config_not_literal) | The `vitehub()` options are a variable, a function call, or `mergeConfig()`. `vitehub status` reports `config.manual` and exits with `0`. | Write an object literal, such as `vitehub({ kv: true })`, or edit the config by hand. |

## Remove a feature

`vitehub remove` undoes `vitehub add` in reverse order: the config first, then the starter files, then the packages, so the app stops using the feature before its files go.

```bash [Terminal]
pnpm vitehub remove queue --dry-run
pnpm vitehub remove queue --yes
pnpm vitehub remove workflow --force --yes --json
```

| Flag | What it does |
| --- | --- |
| `--dry-run`, `--yes`, `--json` | The same as for `add`. |
| `--keep-files` | Keep the starter Definitions. |
| `--no-uninstall` | Keep the packages. `nextSteps` has the uninstall command. |
| `--force` | Turn the feature off while the app still uses it, and keep every file. It writes `<feature>: false` when another feature turns it on. |

`remove` deletes the `vitehub()` key, or writes `<feature>: false` for a feature that is on without one, such as Env. A feature that only the removed one turned on goes off too, listed in `turnedOff`. When `add` was the last change, the config, starter files, and `package.json` get their original bytes back.

It deletes only unchanged starter files, and uninstalls a package only when no enabled feature declares it and no source imports it. While the app still uses the feature, through an import, a changed or extra file in a folder such as `server/queues/`, or a discovered file such as `server/comments.ts`, it exits with `3` and lists each file and line in `references`. Nuxt apps with `srcDir`, layers, or a dynamic `serverDir` get `SETUP_SERVER_DIR_MANUAL`, and `--force` turns the feature off and leaves the files.

::note
`remove` never deletes host resources such as a D1 database or a KV namespace, the local data in `.vitehub/data`, host credentials, or `.vitehub/link.json`. `nextSteps` names the host resources to delete by hand.
::

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_FEATURE_IMPLIED`](/docs/cli/diagnostics/setup_feature_implied) | Another enabled feature turns this one on, such as Agent for Workflow. `impliedBy` names it. | Remove the other feature too, or pass `--force` to write `<feature>: false`. |
| [`SETUP_FEATURE_IN_USE`](/docs/cli/diagnostics/setup_feature_in_use) | The app still uses the feature. `references` lists each file, line, and imported module. | Delete or move them and run again, or pass `--force` and keep the files. |
| [`SETUP_FEATURE_REQUIRED`](/docs/cli/diagnostics/setup_feature_required) | An enabled feature's options require this one, such as `cache: { driver: "kv" }` for KV. `--force` cannot remove it. | Remove both in one command, or change the dependent options first. |
| [`SETUP_UNINSTALL_FAILED`](/docs/cli/diagnostics/setup_uninstall_failed) | The package manager failed after the starter files were deleted. | Run the uninstall command by hand to see the error, then plan the removal again. |

## Use Setup during development

`vite dev` serves Setup endpoints under `/__vitehub/setup` that plan and apply the same changes as `add` and `remove`, with the same JSON. They exist only on the dev server, never in a build.

Only a page that the dev server serves, such as a DevTools panel, can call them. Other origins get `403`, the hosted Console included. Applying a plan also needs writable Setup access under the project's Console policy.

A page gets its session token only over a loopback TCP connection, so forward a remote dev server's port and open `http://localhost:5173`:

```bash [Terminal]
ssh -L 5173:127.0.0.1:5173 user@dev-server
```

A host that `server.allowedHosts` lists by name also works over the local connection, HTTP included, but listing it does not give network clients the token.
