---
title: Project commands
description: Create a ViteHub app, read its features without loading the config, and turn features on and off with the vitehub CLI.
navigation.title: Project
navigation.order: 2
navigation.group: Start
icon: i-lucide-folder-cog
---

Project commands work on the files of your app. They parse `vite.config.*` or `nuxt.config.*` and never run it, so they work before the app starts and when the config does not load. Each error code links to its page in the [CLI diagnostics](/docs/cli/diagnostics).

## Create a project

`vitehub init` creates a ViteHub app in a folder, or sets up the Vite or Nuxt app that is already there. It runs from the `vite-hub` package, so it needs no install first.

```bash [Terminal]
pnpm dlx vite-hub init my-app --host cloudflare --features kv,queue --yes
pnpm dlx vite-hub init my-app --host vercel --features email --option email.driver=resend --yes --json
```

- `<dir>`: the app folder. A new or empty folder gets the app from [Installation](/docs/getting-started/installation): `package.json`, `vite.config.ts` with `vitehub({ host })`, `tsconfig.json`, `server/api/health.get.ts`, and a `.gitignore`. A folder with a Vite or Nuxt app keeps its files; `init` registers `vitehub()` or the Nuxt module in the config. Any other folder that is not empty exits with `3`.
- `--host`: `cloudflare`, `vercel`, `netlify`, `deno`, or `node`. It becomes `host`. An existing ViteHub stack with enabled features keeps its host; migrate its providers and Definitions by hand before changing the host.
- `--features`: feature ids separated by commas, as `vitehub catalog` lists them. `init` plans them in one step with `vitehub add`, so a feature that the host does not support exits with `3` before any file is written.
- `--option feature.key=value`: an option of a feature, such as `email.driver=resend`. Repeat it for more options.
- `--framework vite|nuxt`: the default is `vite`. For `nuxt`, `init` runs the pinned `nuxi init` with a pinned starter and the `5x` nightly channel, checks that it declares a Nuxt 5 version, then adds the `vite-hub/nuxt` module. Existing Nuxt apps must also declare a known Nuxt 5 version before any installation or config edit. A tag or an unsupported version stops adoption and leaves existing files for manual setup.
- `--pm pnpm|npm|yarn|bun`: the package manager. The default is the one that the folder uses, else the one that runs the command, else pnpm.
- `--no-install` skips the install. `nextSteps` gives the install command. `--dry-run` prints the plan and writes nothing.
- `--yes` applies the plan. Without a terminal, a missing input fails and names the flag, for example `Pass --host (cloudflare, vercel, netlify, deno, node) when running without an interactive terminal.` The command exits with `2` and gives `missing` and `rerun`.

`init` writes the command that creates the same stack into `README.md`, between `<!-- vitehub:stack -->` and `<!-- /vitehub:stack -->`. `vitehub status --json` returns it as `stack.command`. A second run of the same command changes nothing.

These `init` errors exit with `3`:

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_INIT_DIR_NOT_EMPTY`](/docs/cli/diagnostics/setup_init_dir_not_empty) | The folder has files but no Vite or Nuxt app, so `init` cannot create or adopt an app there. ViteHub never overwrites a file. | Choose a new or empty folder. |
| [`SETUP_INIT_FRAMEWORK_MISMATCH`](/docs/cli/diagnostics/setup_init_framework_mismatch) | `--framework` names another framework than the app in the folder uses. | Pass the framework of the app, or choose another folder. |
| [`SETUP_INIT_HOST_MIGRATION`](/docs/cli/diagnostics/setup_init_host_migration) | `init` cannot change the host of an existing ViteHub stack with enabled features. It stops before it installs packages or writes files. | Use the current host, or review and migrate the feature options, providers, and Definitions in the config first. |
| [`SETUP_INIT_NUXT_VERSION`](/docs/cli/diagnostics/setup_init_nuxt_version) | The Nuxt app does not declare a known Nuxt 5 version. ViteHub stops before adoption and package installation. Files of a scaffold that the command created remain. | Set `nuxt` to a Nuxt 5 version and run `init` on the folder again. |

## Read a project without loading it

`vitehub catalog` and `vitehub status` run before the CLI loads the project config. They work in an empty folder and on a config that throws, because they parse the config file and never run it.

```bash [Terminal]
pnpm vitehub catalog --json
pnpm vitehub status --json
```

`catalog` lists every feature key of `vitehub({...})`, the packages that it needs, and how each host supports it: `native`, `explicit` (an option chooses the provider), or `unsupported`. It needs no project.

`status` reads `vite.config.*` or `nuxt.config.*` in the current folder. With `vitehub.lock`, it also lists each checkout folder with its local changes and conflicts, read by the installed Workspace package without calling the app; `--json` puts them in `checkouts`. See [Work on Workspace files in a local folder](/docs/cli/content#work-on-workspace-files-in-a-local-folder). `status` reports:

- `framework`: `vite`, `nuxt`, or `none`, from the config files and the dependencies.
- `config`: the file and the config form, or `manual` with the reason when the options are not an object literal.
- `host`: the `host` from the config, else the host from the environment, as `detectHost()` reads it, else `node`. `source` tells which one. A dynamic host or config reports `name: "unknown"` and feature support with `level: "unknown"`.
- `live`: the deployment that receives production traffic, with its commit and how many commits it is `behind` and `ahead` of HEAD. See [List deployments](/docs/cli/deploy#list-deployments).
- `features`: each feature as `on`, `off`, or `unknown`. The reason is `config` when the config sets the key, `default` when it does not (including file discovery in `server/`), and `implied` when another feature turns it on or may turn it on. Expressions and keys overridden by a spread are `unknown`; their implications remain uncertain, respecting explicit `false`. An enabled feature lists `missingPackages` and a `fix`, such as the install command.

With `--json`, a command prints exactly one JSON document on stdout, `{ "schemaVersion": 1, ... }`. A failure prints `{ "schemaVersion": 1, "error": { "code", "message", "why", "fix", "docs" } }`. The exit code is `0` when the command is done, `1` for an error, `2` when input is needed, `3` for an unsupported or conflicting change, and `4` for a stale plan.

## Add a feature

`vitehub add` turns on one or more features. It plans the change first, then installs the owner packages, creates the starter files, and edits the config last. It parses the config and never runs it.

```bash [Terminal]
pnpm vitehub add kv queue --dry-run
pnpm vitehub add queue --name welcome-email --yes
pnpm vitehub add email --option email.driver=resend --yes --json
```

- `--dry-run` prints the diff, or the plan with `--json`, and writes nothing.
- `--yes` applies the plan. In a terminal without `--yes`, the command shows the diff and asks. Without a terminal, or with `--json`, it prints the plan and exits with `2` and a `rerun` command that includes `--yes`.
- `--no-install` skips the install. The plan still lists the packages and the install command.
- `--name <name>` creates a starter Definition, such as `server/queues/<name>.ts`, for each feature that has Definitions: Agent, Database, Queue, Realtime, Schedule, and Workflow. In Nuxt, it uses the application server directory when literal `rootDir` and `serverDir` options make that directory known; unresolved directories require creating the Definition by hand. It never overwrites a file.
- `--option key=value` sets an option of the feature, such as `--option email.driver=resend`. With one feature, the feature name is optional. Dotted keys make nested objects.

The command sets `<feature>: true`, or the object from `--option`. A feature that is already on gives no change, so a second run prints `"status": "unchanged"`. Features that an added feature turns on, such as Workflow for Agent, are listed in `implied`; the config names them when you supply their provider options. When an added feature requires Database, the command explicitly enables it if it was disabled. For example, on Netlify or Deno, `add comments` requires `--option database.connection.url=libsql://your-host` before writing the config.

The host decides what `add` accepts. A feature that the host does not support exits with `3`. A host that needs an explicit provider, such as Email on Vercel, exits with `2` and lists the option in `missing` with its `choices`. When ViteHub can choose the values, `rerun` is a command that succeeds as it is, including any provider prerequisites. Node Schedules require `--option schedule.runtime.driver=process`, or `--option schedule.providerOutput=false` when you will wake them yourself.

Some host defaults build and run but keep state in one process. `nextSteps` names them, with the option that selects a durable provider. For example, Workspace on Vercel keeps files in memory until `BLOB_READ_WRITE_TOKEN` is set. A provider option that needs more packages, such as `workflow.provider=openworkflow` or `blob.driver=s3`, adds them to the install.

`vitehub add console` sets `console: true`, so the app takes only [signed calls](/docs/console/signed-requests). Add `--option console.authorize=server/console-authorize.ts` to limit who may use which section. `--option console.auth=false` takes calls without a signature, for development only. Console does not enable Comments or Database.

`vitehub add observability` registers Evlog. Observability papercut reports require Agent and Console, and the command collects their provider inputs before it applies these options. `--option observability.service=<name>` adds Agent telemetry, installs `@vite-hub/agent`, and supports Agents only when Nitro hosts them. Selecting PostHog installs `posthog-node` and enables Server Env. `--option observability.logs.source=./server/logs.ts` connects an existing log source for production. A Realtime starter enables Workspace; add the Workspace Definition named in its next steps.

When running a pkg.pr.new preview of the CLI, added ViteHub packages use the same preview reference.

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_FEATURE_UNSUPPORTED`](/docs/cli/diagnostics/setup_feature_unsupported) | The host of the project cannot provide the feature. | Run `vitehub catalog` to see which hosts support it, or set `host` to another host. |
| [`SETUP_INPUT_NEEDED`](/docs/cli/diagnostics/setup_input_needed) | The command needs more input, such as a feature name or the provider option that the host needs. The JSON output lists the fields in `missing`. | Run `rerun`, which works when ViteHub can choose a value. |
| [`SETUP_CONFIG_MANUAL`](/docs/cli/diagnostics/setup_config_manual) | `add` or `remove` cannot edit the config safely: there is no `vitehub()` call, there are two, or the options are not an object literal. | Paste the keys from the error into the `vitehub()` options. The JSON output has them in `snippet`. |
| [`SETUP_FILE_EXISTS`](/docs/cli/diagnostics/setup_file_exists) | A starter Definition file exists with other content, or another file already defines the same Definition, such as `src/database.ts` for the Default Database or `src/<name>.queue.ts` for a Queue. ViteHub never overwrites a file and never writes a second Definition. | Choose another `--name`, or edit the file by hand. |
| [`SETUP_SERVER_DIR_MANUAL`](/docs/cli/diagnostics/setup_server_dir_manual) | Nuxt's application server directory needs config evaluation, for example because `serverDir` is an expression or the app uses layers. | Create the Definition in that directory and rerun without `--name`, or use literal directory options without layers. |
| [`SETUP_INSTALL_FAILED`](/docs/cli/diagnostics/setup_install_failed) | The package manager exited with an error. ViteHub did not write starter or config files. The package manager may have changed package manifests or lockfiles, also during an earlier install that succeeded. | Run the install command by hand to see the error. |
| [`SETUP_STALE_PLAN`](/docs/cli/diagnostics/setup_stale_plan) | The config file changed between the plan and the write. | Run the command again. |
| [`SETUP_PLAN_UNKNOWN`](/docs/cli/diagnostics/setup_plan_unknown) | The dev Setup page applied a plan id that the dev server does not have. A plan applies once, and a restart of the dev server drops its plans. | Plan the change again. |
| [`SETUP_NOT_A_PROJECT`](/docs/cli/diagnostics/setup_not_a_project) | The folder has no `package.json`, no `vite.config.*`, and no `nuxt.config.*`. | Run the command in the folder of your Vite or Nuxt app. |
| [`SETUP_CONFIG_NOT_LITERAL`](/docs/cli/diagnostics/setup_config_not_literal) | The `vitehub()` options are not an object literal, for example a variable, a function call, or `mergeConfig()`. ViteHub does not run the config to read them. `vitehub status` reports this case as `config.manual` and exits with `0`. | Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand. |

## Remove a feature

`vitehub remove` undoes `vitehub add`. It plans the change first, then edits the config, deletes the starter files, and uninstalls the packages last, so the app stops using the feature before its files go. It parses the config and never runs it.

```bash [Terminal]
pnpm vitehub remove queue --dry-run
pnpm vitehub remove queue --yes
pnpm vitehub remove workflow --force --yes --json
```

- `--dry-run`, `--yes`, and `--json` work as they do for `add`. Without a terminal and without `--yes`, the command exits with `2` and a `rerun` command.
- `--keep-files` keeps the starter Definitions.
- `--no-uninstall` keeps the packages. `nextSteps` has the uninstall command.
- `--force` turns the feature off while the app still uses it. It writes `<feature>: false` when another feature turns it on, and it keeps every file that the app wrote.

The command deletes the `vitehub()` key. A feature that is on without a key, such as Env, gets `<feature>: false`. A feature that only the removed feature turned on, such as Workflow for Agent, goes off too and is listed in `turnedOff`. When `add` was the last change, `remove` gives back the original bytes of the config, the starter files, and package.json.

`remove` deletes a file only when it is exactly a starter that `add` writes. It refuses with `3` while the app still uses the feature: an import of `vite-hub/<feature>` or of a package that only this feature needs, a changed or extra file in the Definition folder, such as `server/queues/`, or a discovered file, such as `server/comments.ts`. The error lists each file and line in `references`. It uninstalls a package only when no enabled feature declares it and no source file imports it.

When Nuxt directories cannot be resolved without running the config, for example with `srcDir`, layers, or a dynamic `serverDir`, removing a feature with Definitions or discovered files exits with `3` and `SETUP_SERVER_DIR_MANUAL`. Use literal directory options without layers, or pass `--force` to turn it off while leaving those files in place.

`remove` never deletes host resources, such as a D1 database or a KV namespace, the local data in `.vitehub/data`, host credentials, or `.vitehub/link.json`. `nextSteps` names the host resources to delete by hand.

| Code | Cause | Fix |
| --- | --- | --- |
| [`SETUP_FEATURE_IMPLIED`](/docs/cli/diagnostics/setup_feature_implied) | Another enabled feature turns the feature on, such as Agent for Workflow, so deleting its key changes nothing. The JSON output names the other features in `impliedBy`. | Remove the other feature too, or pass `--force` to write `<feature>: false`. |
| [`SETUP_FEATURE_IN_USE`](/docs/cli/diagnostics/setup_feature_in_use) | The app still uses the feature. `references` lists each file, with the line and the module for an import. | Delete or move them and run the command again, or pass `--force` to turn the feature off and keep the files. |
| [`SETUP_FEATURE_REQUIRED`](/docs/cli/diagnostics/setup_feature_required) | The options of an enabled feature require the feature, such as `cache: { driver: "kv" }` requiring KV. `--force` cannot remove these prerequisites. | Remove both features in one command, or change the dependent options first. |
| [`SETUP_UNINSTALL_FAILED`](/docs/cli/diagnostics/setup_uninstall_failed) | The package manager exited with an error after ViteHub deleted the starter files. The terminal command changes the config before it uninstalls. The development Setup page keeps the config unchanged until cleanup succeeds, so a config-triggered restart cannot interrupt cleanup. | Run the uninstall command by hand to see the error, then plan the removal again. |

## Use Setup during development

`vite dev` adds the Setup endpoints below `/__vitehub/setup`. They plan and apply the same feature changes as `vitehub add` and `vitehub remove`, with the same JSON documents. They exist only on the development server, never in a build.

Only a page of the development server itself, such as a DevTools panel, can call them. A page on another origin gets `403`, and the hosted Console too. The endpoints send no CORS headers. Apply also needs writable Setup access under the project's Console policy.

A page gets its session token only over a loopback TCP connection. For a remote dev server, forward its port to your machine, for example `ssh -L 5173:127.0.0.1:5173 user@dev-server`, then open `http://localhost:5173`. A host name that `server.allowedHosts` lists one by one also works over the local connection, HTTP included. Listing a host does not give network clients the session token.
