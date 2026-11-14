---
title: CLI
description: Run package-owned development workflows through the local Vite config.
navigation.order: 31
navigation.group: Local tools
icon: i-lucide-terminal-square
---

The `vitehub` CLI is one entry point for developers and agents. It loads your Vite config and collects the commands each ViteHub package adds, so each command stays with the package that knows the workflow. Each run reads each active plugin's commands and Provision Steps once. The [`vite-hub` npm package](https://www.npmjs.com/package/vite-hub) ships one binary, `vitehub`.

The CLI loads your Vite config without the development invocation route, but with Console routes. `vite dev` keeps its development invocation endpoint inside the reserved `/_vitehub/agent` namespace. An app fallback may contain it, but exact, parameterized, and wildcard routes still conflict. Your own routes keep strict conflict checks. The first SSR import can load the generated Agent registry before server internals finish starting. Registry refreshes still reset found public URL names.

## Install and open help

The `vite-hub` package includes the CLI. Commands come from active Vite
plugins, so a package that is not set up has no commands.

```bash [Terminal]
pnpm add vite-hub
pnpm vitehub --help
```

`@vite-hub/cli` is the command runner that the `vitehub` binary uses. It has no binary of its own.

Help lists the namespaces (command groups) you have:

- `agent`, `channels`, and `conversations` when `hubAgent()` is active.
- `blob`, `database`, `env`, `kv`, `rate-limit`, `schedule`, `workflow`, and `workspace`, each when its plugin is active (`hubBlob()`, `hubDatabase()`, `hubEnv()`, `hubKV()`, `hubRateLimit()`, `hubSchedule()`, `hubWorkflow()`, `hubWorkspace()`).
- `content` when the app defines `server/content.ts`.
- `console` when `console` is on.
- `types`, `task`, `decisions`, and `sandbox` from the framework. `decisions` and `sandbox` do not load the project config, and `sandbox` also runs in a deployed container without Vite.
- `inspect` and `provision`, built into the CLI. Plugin commands named `inspect` are ignored.

```txt [Output]
Usage: vitehub <namespace> <feature> [args...]
       vitehub <command> [args...]

Project:
  catalog     List every ViteHub feature and how each host supports it. Needs no project.
  status      Show the host, the enabled features, and what each one still needs. Reads the config without running it.
  drain       Drain a running Node server before it stops, for systemd ExecStop. Needs no project.

Available namespaces:
  workspace   Workspace development workflows and retained history.
  pull        Merge the remote changes of a Workspace ref into a local folder.
  push        Pull, then commit the local changes of a checkout folder to its ref.
  resolve     Keep the local version of binary files that both sides changed.
  hooks       Git hooks that check checkout folders before a commit and push them with the default branch.
  agent       Agent development workflows.
  blob        Read and write blobs of the Blob stores of the app, on the dev server or on a deployed app.
  channels    External Channel registration workflows.
  conversations  Export Channel conversations.
  content     Inspect, edit, delete, restore, publish, and schedule Content documents in the running dev server or a deployed app.
  cms         Inspect the CMS roles and their permissions.
  database    Database development workflows.
  kv          Read and write keys of the KV stores of the app, on the dev server or on a deployed app.
  queue       List Queue Definitions and send a job to one.
  rate-limit  Read and reset Rate Limit counters of the app, on the dev server or on a deployed app.
  env         Server Env inspection workflows.
  secret      Generate and derive application secrets.
  email       Inspect and preview development Email messages.
  schedule    Run Static Schedule Definitions, start Schedules from the CLI, and inspect their recorded runs.
  workflow    Start and inspect Workflow runs in development.
  task        List and run Nitro tasks, such as server/tasks/seed.ts, in the running app.
  durability  Show where each primitive of this Node server keeps its state: shared, on this host, or in this process.
  types       Generate ViteHub TypeScript declarations.
  i18n        Show translation coverage, and move translations to and from PO files.
  decisions   List the Decisions of the app and run one with a text. Does not load the project config.
  migrate     Rewrite the app for this ViteHub release. Does not load the project config.
  sandbox     Serve and check an SSH Sandbox runner. Does not load the project config.
  inspect     Inspect discovered Definitions, host resources, and generated Provider Output.
  provision   Idempotently create missing provider resources.
```

## Commands

| Command | Status | Owner | Use it for |
| --- | --- | --- | --- |
| `vitehub init` | Available | ViteHub CLI | Create a Vite or Nuxt app, or adopt an existing app, with a host and features. Does not load the project config. |
| `vitehub add` | Available | ViteHub CLI | Turn on features: edit the `vitehub()` options, install the owner packages, and create a starter Definition. Does not load the project config. |
| `vitehub remove` | Available | ViteHub CLI | Turn off features: edit the `vitehub()` options, delete unchanged starter Definitions, and uninstall packages that nothing else uses. Does not load the project config. |
| `vitehub catalog` | Available | ViteHub CLI | List every feature and how each host supports it. Does not load the project config. |
| `vitehub status` | Available | ViteHub CLI | Show the host, the enabled features, what each one still needs, and the checkout folders of `vitehub.lock`. Does not load the project config. |
| `vitehub link` | Available | ViteHub CLI | Link the project to its project on the host in `.vitehub/link.json`. Does not load the project config. |
| `vitehub unlink` | Available | ViteHub CLI | Remove `.vitehub/link.json`. Does not load the project config. |
| `vitehub deploy` | Available | ViteHub CLI | Build the app and run the host deploy that the build wrote, with your local login. Sets the Console link secret and pushes the checkout folders of `vitehub.lock`. Does not load the project config. |
| `vitehub deployments` | Available | ViteHub CLI | List the deployments of the linked project from the host, and mark the one that receives production traffic. Does not load the project config. |
| `vitehub drain` | Available | ViteHub CLI | Drain a running Node server before it stops, for systemd `ExecStop`. Does not load the project config. |
| `vitehub agent eval` | Opt-in tooling | Agent Package | Run discovered Agent Evals through ViteHub defaults. |
| `vitehub agent info` | Available | Agent Package | Inspect resolved Agent metadata through a running Vite Development Server. |
| `vitehub agent dev` | Available | Agent Package | Talk to a discovered Agent through a running Vite Development Server. |
| `vitehub agent invocations` | Available | Agent Package | List, inspect, follow, export, or cancel records in the application's Agent Invocation journal, locally or on a deployed Console, or wait until no Invocation is active. |

| `vitehub blob list` | Available | Blob Package | List blobs of a Blob store, one page at a time. |
| `vitehub blob head` | Available | Blob Package | Show the metadata of one blob. |
| `vitehub blob get` | Available | Blob Package | Download one blob (up to 8 MiB) to a file or to stdout, byte for byte. |
| `vitehub blob put` | Available | Blob Package | Upload one file as a blob and print what changed. |
| `vitehub blob delete` | Available | Blob Package | Delete one blob and print what changed. |
| `vitehub blob media` | Available | Blob Package | Show the media record of one blob: dimensions, hash, alt text, focal point, and crops. |
| `vitehub blob variants` | Available | Blob Package | List the cached image variants of one blob. |
| `vitehub conversations export` | Available | Agent Package | Export one conversation as Markdown or JSON, to stdout or to a directory with its attachments. |
| `vitehub channels history` | Available | Agent Package | Download one deployed conversation and its attachments with the webhook secret. It writes the same archive as `conversations export --format json --output`. |
| `vitehub channels sync` | Available | Agent Package | Inspect or apply provider-owned webhook registrations for a deployed stage. |
| `vitehub channels replay` | Available | Agent Package | Replay stored Channel history through an Agent from a development server or authenticated Console. |
| `vitehub content collections` | Available | Content Package | List collections and singletons with their fields and document counts. |
| `vitehub content list` | Available | Content Package | List the documents of one collection with their state, title, and field issues. |
| `vitehub content show` | Available | Content Package | Print the stored file of one document and its field issues. |
| `vitehub content status` | Available | Content Package | Show whether each document is draft, published, changed, or deleted, with field issues and schedules. |
| `vitehub content diff` | Available | Content Package | Print a unified diff of one document from published to draft. |
| `vitehub content revisions` | Available | Content Package | List the revisions of one document, newest first. |
| `vitehub content edit` | Available | Content Package | Edit one draft in `$EDITOR` or save it from a file. Honours edit leases unless `--override-lease`. |
| `vitehub content delete` | Available | Content Package | Delete one draft after confirmation, pinned to its digest. The next publish deletes it from the site. |
| `vitehub content restore` | Available | Content Package | Save the version of a document from `--revision` as its draft, pinned to the draft digest that it read. Publishes nothing. |
| `vitehub content publish` | Available | Content Package | Publish the listed draft documents in one revision after confirmation, pinned to their digests. |
| `vitehub content previews` | Available | Content Package | Print pull request preview links as a Markdown comment, or create or update the comment with `comment --pr <n> --post`. See [Pull request previews](/docs/content/cli#pull-request-previews). |
| `vitehub content schedule` | Available | Content Package | Publish the listed draft documents at a later time, pinned to their digests. |
| `vitehub content scheduled` | Available | Content Package | List pending, overdue, and failed schedules. |
| `vitehub content unschedule` | Available | Content Package | Cancel a pending schedule, or dismiss a failed one. |
| `vitehub content sitemap` | Available | Content Package | Print the sitemap URLs of published documents. |
| `vitehub content head` | Available | Content Package | Show the commit that each `github()` Source serves, the rejected commit, the last webhook delivery, and what holds the head back. |
| `vitehub content advance` | Available | Content Package | Move the head of a `github()` Source to the latest commit of its branch when every document parses and `content check` finds no error. Exits 1 when the head is held back. |
| `vitehub content pin` | Available | Content Package | Serve one commit of a `github()` Source until `unpin`, for example to roll back. |
| `vitehub content unpin` | Available | Content Package | Remove the pin of a `github()` Source and move to the latest valid commit. |
| `vitehub content check` | Available | Content Package | Check frontmatter, links, titles, and descriptions of Content documents. With `--dir`, check a folder without an app. Exits 1 on errors. |
| `vitehub cms roles` | Available | CMS Package | List each CMS role with the Content and Comments actions it allows. See [Roles and access](/docs/cms/access). |
| `vitehub connections` | Available | Connections Package | Connect OAuth accounts, set API keys, list Connections, read activity, and approve or deny writes. |
| `vitehub env inspect` | Available | Env Package | List declared Server Env variables and their status without values. |
| `vitehub env check` | Available | Env Package | Fail CI or a deploy step when Server Env would not load for a stage. |
| `vitehub secret generate` | Available | Env Package | Print a new root secret for `VITEHUB_SECRET`. |
| `vitehub secret derive` | Available | Env Package | Print the secret derived from `VITEHUB_SECRET` for one purpose. |
| `vitehub secret console-key` | Available | Env Package | Print a new key pair for signed Console requests. |
| `vitehub email outbox` | Available | Email Package | List, show, or clear the messages that the development outbox captured, on the dev server or with `--url`. |
| `vitehub email preview` | Available | Email Package | Render a `server/emails` template without sending it. Needs no server. |
| `vitehub database generate` | Available | Database Package | Refresh generated Database artifacts and generate Drizzle migrations. |
| `vitehub database migrate` | Available | Database Package | Refresh generated Database artifacts and apply Drizzle migrations. |
| `vitehub database up` | Available | Database Package | Convert migrations folders of Drizzle Kit 0.x to the Drizzle Kit 1.0 layout. |
| `vitehub database export` | Available | Database Package | Write a SQL dump of the local SQLite file, or of the deployed database with `--remote`. |
| `vitehub database seed` | Available | Database Package | Run the seed file of each database on the local database, or on the deployed database with `--remote`. |
| `vitehub database tables` | Available | ViteHub Framework | List the tables of a database with their columns and relationships, from the running app or a deployment. |
| `vitehub database rows` | Available | ViteHub Framework | Read one page of rows of a table, sorted or searched, from the running app or a deployment. |
| `vitehub migrate run` | Available | Codemods Package | Rewrite an app folder for this ViteHub release with the codemods of `@vite-hub/codemods`. `vitehub migrate` runs it on the current folder, and `--dry-run` prints the diffs. Install `@vite-hub/codemods` as a development dependency first. |
| `vitehub kv list` | Available | KV Package | List the keys of one KV store, one page at a time. |
| `vitehub kv get` | Available | KV Package | Print the value of one key. |
| `vitehub kv has` | Available | KV Package | Check if a key exists. The exit status is 0 or 1. |
| `vitehub kv set` | Available | KV Package | Write the value of one key and print what changed. |
| `vitehub kv delete` | Available | KV Package | Delete one key and print what changed. |
| `vitehub rate-limit peek` | Available | Rate Limit Package | Show the counter of one key without consuming a token. |
| `vitehub rate-limit reset` | Available | Rate Limit Package | Delete the counter of one key, where the provider supports it. |
| `vitehub schedule runs` | Available | Schedule Package | List the recorded runs of one Schedule, newest first. |
| `vitehub schedule attempts` | Available | Schedule Package | List the attempts of one Schedule Run. |
| `vitehub schedule run` | Available | Schedule Package | Run a manual Static Schedule Definition locally, or on a deployment with `--url`. |
| `vitehub schedule list` | Available | Schedule Package | List the Schedules that code started with `startSchedule()`. |
| `vitehub schedule start` | Available | Schedule Package | Start a Schedule Definition without `cron`, once with `--at` or on `--cron`. |
| `vitehub schedule cancel` | Available | Schedule Package | Cancel a started Schedule. |
| `vitehub i18n export` | Available | i18n Package | Write the messages and translations of one locale as a PO file. |
| `vitehub i18n import` | Available | i18n Package | Save the translations of a PO file as records in `locales/<locale>/`. |
| `vitehub i18n prune` | Available | i18n Package | Delete the records of messages that the code no longer has. Lists them unless --yes. Export changed messages first: prune deletes their old translations. |
| `vitehub i18n status` | Available | i18n Package | Show how many messages each locale translates. |
| `vitehub decisions list` | Available | Decisions Package | List the exports of `defineChoices()` results, by file. |
| `vitehub decisions run` | Available | Decisions Package | Run one Decision with a text and print the selection as JSON, or the questions with `--inspect`. |
| `vitehub queue list` | Available | Queue Package | List the Queue Definitions of the app and the provider that sends their jobs. |
| `vitehub queue send` | Available | Queue Package | Send one job to a Queue Definition. |
| `vitehub queue jobs` | Available | Queue Package | List, show, retry, or clear stored jobs in development or on a Node server with the local provider. Supports `--json` and `--url`. Clearing jobs asks for confirmation, or needs `--yes` without a terminal. |
| `vitehub task list` | Available | ViteHub Framework | List the Nitro tasks that the app registers. |
| `vitehub task run` | Available | ViteHub Framework | Run one Nitro task, such as a seed or a backfill, with the app's bindings. |
| `vitehub durability list` | Available | ViteHub Framework | Show where each primitive of a Node server keeps its state (`shared`, `host`, or `process`), and the instance count. See [Durability and instances](/docs/frameworks-hosts/node-self-hosted#durability-and-instances). |
| `vitehub agent usage` | Available | ViteHub Framework | Read token use and cost of Agent Invocations over a time window. |
| `vitehub sandbox check` | Available | Sandbox Package | Start the provider Driver through the SSH runner and report readiness. |
| `vitehub sandbox serve` | Available | Sandbox Package | Serve authenticated SSH commands from this machine. With `--drain-timeout <ms>` or `VITEHUB_SANDBOX_DRAIN_TIMEOUT_MS`, SIGTERM and SIGINT stop new connections and wait up to that time for open ones to close. |
| `vitehub workflow start` | Available | Workflow Package | Start a discovered Workflow in the local development runtime. |
| `vitehub workflow get` | Available | Workflow Package | Read a Workflow run. |
| `vitehub workflow cancel` | Available | Workflow Package | Cancel a run when the provider supports it. |
| `vitehub workflow resume` | Available | Workflow Package | Resume a Workflow signal by hook token. |
| `vitehub workflow runs` | Available | Workflow Package | List, show, or clear the Workflow runs that `vite dev` recorded. Show includes steps, status, result, and error. Clearing history asks for confirmation, or needs `--yes` without a terminal. |
| `vitehub workspace dev` | Available | Workspace Package | Run commands through a Workspace Session exposed by a Compatible Vite Development Server. |
| `vitehub workspace history` | Available | Workspace Package | List the retained revisions of a Workspace with ref, author, message, and time. |
| `vitehub workspace refs` | Available | Workspace Package | List the history refs of a Workspace and their head revisions. |
| `vitehub workspace show` | Available | Workspace Package | Show one revision and its files, or print one file as it was in that revision. |
| `vitehub workspace changes` | Available | Workspace Package | List the files of a ref that changed since a revision, with their content. `vitehub pull` reads it. |
| `vitehub workspace stale` | Available | Workspace Package | List derived files on a ref, such as translations, whose `derivedFrom` source changed or is gone. |
| `vitehub workspace commit` | Available | Workspace Package | Commit files to a ref when its head is still `ifHead`. `vitehub push` calls it. |
| `vitehub pull` | Available | Workspace Package | Merge the remote changes of each checked-out Workspace ref into its local folder, and update `vitehub.lock`. |
| `vitehub push` | Available | Workspace Package | Pull, then commit the local changes of each checkout folder to its ref. It never publishes or deploys. |
| `vitehub hooks install` | Available | Workspace Package | Write `.git/hooks/pre-commit` and `pre-push`, or print the commands for Husky, lefthook, pre-commit, simple-git-hooks, or `core.hooksPath`. |
| `vitehub hooks uninstall` | Available | Workspace Package | Remove the hooks that `vitehub hooks install` wrote. |
| `vitehub hooks pre-commit` | Available | Workspace Package | Fail while a checkout folder has conflicts. Works offline. |
| `vitehub hooks pre-push` | Available | Workspace Package | Run `vitehub push` when the Git push updates the default branch. Fails when that changes `vitehub.lock` or pulls files: commit them and push again. |
| `vitehub resolve` | Available | Workspace Package | Keep the local version of binary files that both sides changed. |
| `vitehub types prepare` | Available | ViteHub Framework | Prepare generated TypeScript declarations for editors and type checking. |
| `vitehub inspect definitions` | Available | ViteHub CLI plus package inspection contributors | List the Definitions that each active package discovered. |
| `vitehub inspect output` | Available | ViteHub CLI plus package inspection contributors | List generated Provider Output files with secrets redacted. |
| `vitehub inspect resources` | Available | ViteHub CLI plus package inspection contributors | List the host resources that Definitions map to, with each id and where it came from. |
| `vitehub provision run` | Available | ViteHub CLI plus package Provision Steps | Create missing provider resources idempotently. |
| `vitehub provision status` | Available | ViteHub CLI plus package Provision Steps | Show recorded provider ids, ids that no Definition declares, and pending plan actions. |

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

### `SETUP_INIT_DIR_NOT_EMPTY`

The folder has files but no Vite or Nuxt app, so `init` cannot create or adopt an app there. ViteHub never overwrites a file. Choose a new or empty folder. The command exits with `3`.

### `SETUP_INIT_FRAMEWORK_MISMATCH`

`--framework` names another framework than the app in the folder uses. Pass the framework of the app, or choose another folder. The command exits with `3`.

### `SETUP_INIT_HOST_MIGRATION`

`init` cannot change the host of an existing ViteHub stack with enabled features. Use its current host, or review and migrate the feature options, providers and Definitions in the config first. The command exits with `3` before installing packages or writing files.

### `SETUP_INIT_NUXT_VERSION`

The Nuxt app does not declare a known Nuxt 5 version. ViteHub stops before adoption and package installation. If the command created a scaffold, those files remain. Set `nuxt` to a Nuxt 5 version and run `init` on the folder again. The command exits with `3`.

## Read a project without loading it

`vitehub catalog` and `vitehub status` run before the CLI loads the project config. They work in an empty folder and on a config that throws, because they parse the config file and never run it.

```bash [Terminal]
pnpm vitehub catalog --json
pnpm vitehub status --json
```

`catalog` lists every feature key of `vitehub({...})`, the packages that it needs, and how each host supports it: `native`, `explicit` (an option chooses the provider), or `unsupported`. It needs no project.

`status` reads `vite.config.*` or `nuxt.config.*` in the current folder and reports the items below. With `vitehub.lock`, it also lists each checkout folder with its local changes and conflicts, read by the installed Workspace package without calling the app; `--json` puts them in `checkouts`. See [Work on Workspace files in a local folder](#work-on-workspace-files-in-a-local-folder).

`status` reports:

- `framework`: `vite`, `nuxt`, or `none`, from the config files and the dependencies.
- `config`: the file and the config form, or `manual` with the reason when the options are not an object literal.
- `host`: the `host` from the config, else the host from the environment, as `detectHost()` reads it, else `node`. `source` tells which one. A dynamic host or config reports `name: "unknown"` and feature support with `level: "unknown"`.
- `live`: the deployment that receives production traffic, with its commit and how many commits it is `behind` and `ahead` of HEAD. See [List deployments](#list-deployments).
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

Some host defaults build and run but keep state in one process. `nextSteps` names them, with the option that selects a durable provider. For example, Workflow on Node and Deno runs inline in the request process until you select OpenWorkflow, and Workspace on Vercel keeps files in memory until `BLOB_READ_WRITE_TOKEN` is set. A provider option that needs more packages, such as `workflow.provider=openworkflow` or `blob.driver=s3`, adds them to the install.

`vitehub add console` sets `console: true`, so the app takes only [signed calls](/docs/development/console#sign-console-requests). Add `--option console.authorize=server/console-authorize.ts` to limit who may use which section. `--option console.auth=false` takes calls without a signature, for development only.

Observability papercut reports require Agent and Console. The command collects their provider inputs before applying these options.

Console does not enable Comments or Database. `vitehub add observability` registers Evlog. `--option observability.service=<name>` adds Agent telemetry, installs `@vite-hub/agent`, and supports Agents only when Nitro hosts them. Selecting PostHog installs `posthog-node` and enables Server Env. `--option observability.logs.source=./server/logs.ts` connects an existing log source for production. A Realtime starter enables Workspace; add the Workspace Definition named in its next steps.

When running a pkg.pr.new preview of the CLI, added ViteHub packages use the same preview reference.

### `SETUP_FEATURE_UNSUPPORTED`

The host of the project cannot provide the feature. Run `vitehub catalog` to see which hosts support it, or set `host` to another host.

### `SETUP_INPUT_NEEDED`

The command needs more input, such as a feature name or the provider option that the host needs. The JSON output lists the fields in `missing`, and `rerun` gives a command that works when ViteHub can choose a value.

### `SETUP_CONFIG_MANUAL`

`vitehub add` or `vitehub remove` cannot edit the config safely: there is no `vitehub()` call, there are two, or the options are not an object literal. The error gives the keys to paste into the `vitehub()` options, and the JSON output has them in `snippet`.

### `SETUP_FILE_EXISTS`

A starter Definition file exists and has other content, or another file already defines the same Definition, such as `src/database.ts` for the Default Database or `src/<name>.queue.ts` for a Queue. ViteHub never overwrites a file and never writes a second Definition. Choose another `--name`, or edit the file by hand.

### `SETUP_SERVER_DIR_MANUAL`

Nuxt's application server directory needs config evaluation, for example because `serverDir` is an expression or the app uses layers. Create the Definition in that directory and rerun without `--name`, or use literal directory options without layers.

### `SETUP_INSTALL_FAILED`

The package manager exited with an error. ViteHub did not write starter or config files. The package manager may have changed package manifests or lockfiles, including during an earlier successful install. Run the install command by hand to see the error.

### `SETUP_STALE_PLAN`

The config file changed between the plan and the write. Run the command again.

### `SETUP_PLAN_UNKNOWN`

The dev Setup page applied a plan id that the dev server does not have. A plan applies once, and a restart of the dev server drops its plans. Plan the change again.

### `SETUP_NOT_A_PROJECT`

The folder has no `package.json`, no `vite.config.*`, and no `nuxt.config.*`. Run the command in the folder of your Vite or Nuxt app.

### `SETUP_CONFIG_NOT_LITERAL`

The `vitehub()` options are not an object literal, for example a variable, a function call, or `mergeConfig()`. ViteHub does not run the config to read them. Write the options as an object literal, such as `vitehub({ kv: true })`, or edit the config by hand. `vitehub status` reports this case as `config.manual` and exits with `0`.

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

### `SETUP_FEATURE_IMPLIED`

Another enabled feature turns the feature on, such as Agent for Workflow, so deleting its key changes nothing. Remove the other feature too, or pass `--force` to write `<feature>: false`. The JSON output names the other features in `impliedBy`.

### `SETUP_FEATURE_IN_USE`

The app still uses the feature. `references` lists each file, with the line and the module for an import. Delete or move them and run the command again, or pass `--force` to turn the feature off and keep the files.

### `SETUP_FEATURE_REQUIRED`

An enabled feature's options require the feature, such as `cache: { driver: "kv" }` requiring KV. Remove both features in one command, or change the dependent options first. `--force` cannot remove these prerequisites.

### `SETUP_UNINSTALL_FAILED`

The package manager exited with an error after ViteHub deleted the starter files. The terminal command changes the config before uninstalling. The development Setup page keeps the config unchanged until cleanup succeeds, so a config-triggered restart cannot interrupt cleanup. Run the uninstall command by hand to see the error, then plan the removal again.

## Use Setup during development

`vite dev` adds the Setup endpoints below `/__vitehub/setup`. They plan and apply the same feature changes as `vitehub add` and `vitehub remove`, with the same JSON documents. They exist only on the development server, never in a build.

Only a page of the development server itself, such as a DevTools panel, can call them. A page on another origin gets `403`, and the hosted Console too. The endpoints send no CORS headers. Apply also needs writable Setup access under the project's Console policy.

A page gets its session token only over a loopback TCP connection. For a remote dev server, forward its port to your machine, for example `ssh -L 5173:127.0.0.1:5173 user@dev-server`, then open `http://localhost:5173`. A host name that `server.allowedHosts` lists one by one also works over the local connection, HTTP included. Listing a host does not give network clients the session token.

## Link a project to its host

`vitehub link` connects the project to a project on its host, so later commands know where to deploy. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub link
pnpm vitehub link --host cloudflare --account <id> --create
pnpm vitehub unlink
```

- `--host`: `cloudflare`, `vercel`, `netlify`, or `deno`. The default is the host that `vitehub status` reports.
- `--project`: the project name on the host. The default is the `name` of `vitehub({ name })`, else the package.json name, in the same form that the build uses.
- `--account`: the Cloudflare account id, the Vercel team id, or the Netlify team slug.
- `--create`: create the project when the host does not have it. Without it, a missing project exits with `3`.

The credentials come from environment variables first, then from the host CLI login: `CLOUDFLARE_API_TOKEN` or a Wrangler login, `VERCEL_TOKEN` and `VERCEL_TEAM_ID`, `NETLIFY_AUTH_TOKEN`. For Cloudflare, install Wrangler in the project (for example, `pnpm add -D wrangler`) and run `pnpm exec wrangler login`, or make `wrangler` available on `PATH`. A login made only through a cached `npx` or `pnpm dlx` invocation needs that installation before ViteHub can discover it. ViteHub never stores or prints a token.

The command looks up the project through the host API: a Worker on Cloudflare, a project on Vercel, a site on Netlify. Deno has no lookup yet, so the link keeps the name with `verified: false`. The link is in `.vitehub/link.json`:

```json [.vitehub/link.json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "account": { "id": "023e105f4ecef8ad9ca31a8372d0c353" },
  "project": { "id": "e8f70fdbc8b1fb0b8ddb1af166186758", "name": "my-app" },
  "verified": true,
  "linkedAt": "2026-11-05T12:00:00.000Z"
}
```

The file holds no secret, but it is local to your machine. `link` adds `.vitehub` to the project `.gitignore` when it is not there. `vitehub status` shows the link in `link` and where the credentials come from in `credentials`. `vitehub unlink` removes the file and does not change the project on the host.

### `SETUP_LINK_HOST_UNSUPPORTED`

The host is `node`, a self-hosted server, which has no project to link. Pass `--host`, or set `host` in `vitehub()`. The command exits with `3`.

### `SETUP_LINK_CREDENTIALS_MISSING`

No token was found in the environment or in the host CLI login. Run the login command or set the environment variable that the `fix` names. The command exits with `2` and lists the variables in `missing`.

### `SETUP_LINK_ACCOUNT_REQUIRED`

The Cloudflare token has access to more than one account, or to none. The command exits with `2` and lists the accounts in `missing[0].choices`. Run it again with `--account <id>`.

### `SETUP_LINK_NAME_REQUIRED`

The project name is not known, for example because `vitehub({ name })` is an expression. Pass `--project <name>`. The command exits with `2`.

### `SETUP_LINK_PROJECT_NOT_FOUND`

The host has no project with that name. Run the command in `rerun`, which adds `--create`, or pass `--project` with the name of a project that exists. The command exits with `3`.

## Deploy from your machine

`vitehub deploy` builds the app, then runs the deploy that the build wrote for its host. It runs on your machine with your host login. It does not add a CI workflow.

```bash [Terminal]
pnpm vitehub deploy
pnpm vitehub deploy --preview
pnpm vitehub deploy --temporary --yes --json
```

- `--preview`: a preview deploy instead of production. Deno has none. A preview does not push the checkout folders of `vitehub.lock`.
- `--no-build`: deploy the build output that is there.
- `--no-push`: do not check or push the checkout folders of `vitehub.lock`.
- `--temporary`: deploy without an account. Only Cloudflare and Vercel have it, and only when no credentials are found.
- `--yes`: deploy without the question. Without a terminal, the command needs it and exits with `2` and a `rerun`.

The command runs each host CLI with an argument array and no shell. It runs only the deploy command that ViteHub's build writes, and refuses any other command.

| Host | Deploy |
| --- | --- |
| Cloudflare | `wrangler deploy --config ./server/wrangler.json` from `commands.deploy` in `.output/nitro.json`, with `--tag` and `--message` for the commit. With `database.migrateOnDeploy`, it first runs `wrangler d1 migrations apply <binding> --remote` for each D1 binding, and stops when one fails. `--preview` runs `wrangler versions upload` and applies no migrations. |
| Vercel | `vercel deploy --prebuilt --prod --project <name>`, with `--meta vitehubCommit=<sha>` |
| Netlify | `netlify deploy --no-build --dir dist --prod`, with `--message` for the commit |
| Deno | `node .output/deploy.mjs` with `DENO_DEPLOY_ORG` and `DENO_DEPLOY_APP` |

The credentials are the ones that `vitehub link` reads, and the host CLIs read them from the environment. Vercel deploys also accept a saved `vercel login` session, checked with `vercel whoami`, without requiring `VERCEL_TOKEN`. Deno also needs `DENO_DEPLOY_ORG`, or a link with `--account <org>`.

A temporary deploy has no account. The command prints the claim link: claim a Cloudflare Worker within 60 minutes. `--json` returns it in `temporary.claimUrl`. Do not share the claim link.

After a first deploy, `.vitehub/link.json` gets the host project with `verified: false`, so `vitehub status` finds it. Run `vitehub link` to verify it.

### Push the checkout folders

When `vitehub.lock` has checkout folders, a production deploy also pushes them, as `vitehub push` does. The project must install `@vite-hub/workspace` or `vite-hub`, which read the lock. Without a lock or a checkout, the deploy does not push. Without that package, it does not push and prints one warning when the lock has checkout folders.

1. After the deploy question and before the build, the command checks each folder for conflicts, pulls remote changes, and checks for conflicts again. The build uses the pulled files. A declined question loads no project code. A file with unresolved conflicts stops the deploy with `SETUP_DEPLOY_CHECKOUT_CONFLICT`. A failed pull stops it before the build or deploy. An installed package that does not load stops it with `SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`.
2. After the deploy, it pushes each folder to the app that `remote` of its lock entry names. A folder without `remote` goes to the dev server, as with `vitehub push`.
3. The push pulls again, so it can change `vitehub.lock` and files in the folders. The command lists the files changed by both pulls and the push. Commit them.

A `--preview` deploy does not push, so a preview never writes the shared Workspace ref. `--json` returns the push in `checkouts`:

```json [vitehub deploy --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "url": "https://my-app.example.workers.dev",
  "checkouts": {
    "results": [{ "workspace": "docs", "ref": "main", "revision": "r3", "pushed": ["guide.md"], "pull": { "ref": "main", "from": "r1", "head": "r2", "files": [{ "path": "news.md", "action": "added" }] } }],
    "changed": ["vitehub.lock", "content/news.md"]
  }
}
```

### `SETUP_DEPLOY_HOST_UNSUPPORTED`

The host is `node`. Start the server in `.output` yourself. The command exits with `3`.

### `SETUP_DEPLOY_CREDENTIALS_MISSING`

No token was found. Run the login command or set the variable that the `fix` names. On Cloudflare and Vercel, `rerun` is a temporary deploy that needs no account. The command exits with `2`.

### `SETUP_DEPLOY_TEMPORARY_UNSUPPORTED`

The host has no temporary deploy, `--preview` was passed, credentials were found, or the Vercel CLI refuses it (in CI, or in a folder with `.vercel/project.json`). The command exits with `3`.

### `SETUP_DEPLOY_PREVIEW_UNSUPPORTED`

The Deno deploy that the build writes always goes to production. The command exits with `3`.

### `SETUP_DEPLOY_ORG_REQUIRED`

Set `DENO_DEPLOY_ORG`, or run `vitehub link --host deno --account <org>`. The command exits with `2`.

### `SETUP_DEPLOY_BUILD_FAILED`

The build script failed, or package.json has no `build` script. The command exits with `1`.

### `SETUP_DEPLOY_OUTPUT_MISSING`

The build output has no `deployment.json` or no deploy command for the host. Build again. The command exits with `1`.

### `SETUP_DEPLOY_HOST_MISMATCH`

The configured host conflicts with the link, or the build output is for another host. A configured host conflict is rejected before building or uploading existing output. The command exits with `3`.

### `SETUP_DEPLOY_COMMAND_REJECTED`

The deploy command in the build output is not the one that ViteHub writes, so the command does not run it. The command exits with `1`.

### `SETUP_DEPLOY_FAILED`

A host CLI exited with an error. The reason shows its last lines. The command exits with `1`.

### `SETUP_DEPLOY_CHECKOUT_CONFLICT`

A checkout folder of `vitehub.lock` has a file with conflict markers or an open binary conflict. Nothing was built or deployed. Remove the markers, or run `vitehub resolve` for a binary file, then deploy again. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_CHECKOUT_MODULE_FAILED`

The project installs `@vite-hub/workspace/checkout` or `vite-hub/workspace/checkout`, but the module does not load: it has a syntax error, a missing dependency, an error when it starts, or no `localCheckoutStatus` and `pushWorkspaces` exports. Nothing was built or deployed. Reinstall the dependencies and use the same version of the Workspace package as the CLI. `--no-push` deploys without the push. The command exits with `1`.

### `SETUP_DEPLOY_PUSH_FAILED`

The app is deployed, but the Workspace push failed. `checkouts.error` has the code, message, and fix of the push. Fix the cause and run `vitehub push`. Do not deploy again. The command exits with `1`.

## List deployments

`vitehub deployments` reads the deployments of the linked project from the host each time. ViteHub keeps no local deploy log. It needs a host link in `.vitehub/link.json` (from `vitehub link` or a first `vitehub deploy`) and the credentials that `vitehub link` reads.

```bash [Terminal]
pnpm vitehub deployments
pnpm vitehub deployments --limit 20 --json
```

Each deployment has `id`, `url`, `createdAt`, `state` (`ready`, `building`, `error`, `canceled`, or `unknown`), `target` (`production` or `preview`), `live` (true for the one that receives production traffic), `source` (`cli`, `git`, `dashboard`, `api`, or `unknown`), and `commit`. `commit.from` is `vitehub` for the marker that `vitehub deploy` writes, and `host` for the commit of a Git integration build. `--limit` is 1 to 100, and the default is 10.

```json [vitehub deployments --json]
{
  "schemaVersion": 1,
  "host": "cloudflare",
  "project": { "name": "my-app" },
  "deployments": [
    {
      "id": "182bd5e5-6e1a-4fe4-a799-aa6d9a6ab26e",
      "url": "https://my-app.example.workers.dev",
      "createdAt": "2026-11-05T18:11:19.117Z",
      "state": "ready",
      "target": "production",
      "live": true,
      "version": "bcf48806-b317-4351-9ee7-36e7d557d4de",
      "commit": { "sha": "4f2a9c0e8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a39", "dirty": false, "from": "vitehub" },
      "source": "cli"
    }
  ]
}
```

| Host | Deployments | Live | Commit |
| --- | --- | --- | --- |
| Cloudflare | Workers API `.../workers/scripts/{name}/deployments` and `.../versions`. A version in no deployment is a preview. | The newest deployment | The `workers/message` annotation of the version |
| Vercel | `GET /v6/deployments?projectId=` | `targets.production` of the project | `meta.vitehubCommit`, else `meta.githubCommitSha` |
| Netlify | `GET /api/v1/sites/{site_id}/deploys` | `published_deploy` of the site | The deploy `title`, else `commit_ref` |
| Deno | `deno deploy deployments list --json` | `productionRevisionId` of `deno deploy apps get --json` | None. Deno Deploy keeps no deploy message. |

`vitehub status` adds a `live` field and a `live` line, such as `live  4f2a9c0 (3 commits behind)`. `behind` and `ahead` come from `git rev-list --left-right --count <sha>...HEAD` when the commit is in the local repository. Otherwise `live.unknownReason` is `commit-not-local`, `no-marker`, or `no-git`. `status` asks the host only when the project is linked and the credentials resolve, and gives credential discovery and deployment lookup a shared 5-second budget. It follows the host’s production pointer even when that deployment is older than the recent history page. When it cannot read the host, `live` is `null` and `liveReason` is `offline`, `not-linked`, `no-credentials`, `no-live-deployment`, `timeout`, or `host-error`. The exit code stays `0`. Pass `--offline` to skip host requests and credential CLI discovery; the credential summary then uses environment variables only.

### `SETUP_DEPLOYMENTS_NOT_LINKED`

The project has no host link. Run `vitehub link`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_CREDENTIALS_MISSING`

No token was found for the linked host. Run the login command or set the variable that the `fix` names. The command exits with `2`.

### `SETUP_DEPLOYMENTS_ACCOUNT_REQUIRED`

The Cloudflare account is not known. Set `CLOUDFLARE_ACCOUNT_ID`, or run `vitehub link --host cloudflare --account <id>`. The command exits with `2`.

### `SETUP_DEPLOYMENTS_PROJECT_ID_REQUIRED`

The Netlify link has no site id. Run `vitehub link --host netlify`. The command exits with `2`.

## Read and write blobs

Start the dev server, then run `vitehub blob` in another terminal. Each command runs a `blob.*` [operation](/docs/development/operations) of the app, so it uses the app's blobs. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](#run-any-operation).

```bash [Terminal]
pnpm vitehub blob list --prefix avatars/ --limit 20
pnpm vitehub blob head avatars/ada.png
pnpm vitehub blob get avatars/ada.png --output ./ada.png
pnpm vitehub blob get reports/2026.csv > report.csv
pnpm vitehub blob put avatars/ada.png ./ada.png --content-type image/png
pnpm vitehub blob delete avatars/ada.png
pnpm vitehub blob media avatars/ada.png
pnpm vitehub blob variants avatars/ada.png --json
```

Each write command prints what it changed:

```txt [Output]
Created blob avatars/ada.png in store default (48213 B, image/png).
Deleted blob avatars/ada.png from store default.
```

Every command takes `--store <name>`, `--json`, `--url <url>` for a deployed app, and `--timeout <ms>`. The default Blob store is used unless you pass `--store`. Store names come from `blob.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints pathname, size, content type, and upload time. `--limit` defaults to 100, at most 250. When more blobs exist, stderr shows the `--cursor` for the next page.
- `head` prints one blob's metadata. A missing blob exits with status 1.
- `get` writes the bytes unchanged, to stdout by default, so redirect them. `--output <file>` writes the file and prints a summary. `--json` needs `--output`.
- `put` uploads a file relative to the current directory. Without `--content-type`, Blob storage guesses the type from the pathname. The output says if the blob was created or replaced. This label is a best guess from a metadata read just before the write, so eventual consistency and concurrent writers can make it wrong.
- `media` prints the blob's [media record](/docs/blob/media). A missing record is built from the object and stored, as `blob.media.get()` does. A missing blob exits with status 1.
- `variants` lists a blob's cached image variants and crop replacements, with transform key, type, and size.
- `put` and `delete` refuse paths under `_vitehub/` (`BLOB_RESERVED_PATH`), which ViteHub keeps for itself. `get` and `head` can read them. The CLI replaces an existing blob without asking. The Console asks first (`overwrite: false` makes `blob.put` fail with `BLOB_EXISTS`).
- `delete` says if the blob existed, which is a best guess for the same reason. Deleting a missing blob changes nothing and exits with status 0.

Files travel as base64 in a JSON call, so `put` and `get` handle up to 8 MiB. The CLI checks an upload's size before it reads the file. Larger blobs fail with `BLOB_UPLOAD_TOO_LARGE` or `BLOB_DOWNLOAD_TOO_LARGE`, so use the app or your provider's tools. There is no `sign` command. `list` shows every object, including those under `_vitehub/` that the Console hides by default.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. The commands print no object URLs, because a signed URL can carry credentials. `media` prints the record's served route URL, which carries none. Metadata values under secret names, such as `token`, are redacted.

The operations are `blob.list`, `blob.head`, `blob.get`, `blob.put`, `blob.delete`, `blob.media`, and `blob.variants`, in the `blob` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `blob` section. `blob.put` writes and `blob.delete` is destructive. `vitehub blob delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console Blob page uses the same operations.

## Inspect the Email development outbox

When the dev server has Email on, read the in-memory outbox from another terminal:

```bash [Terminal]
pnpm vitehub email outbox list
pnpm vitehub email outbox show <id> --html
pnpm vitehub email outbox clear
```

Add `--json` for machine-readable output. The outbox exists only in `vite dev` and empties when the server restarts. `vitehub email preview <template>` renders a `server/emails` template without sending it, in your terminal, with no server.

The commands run `email.outbox-list`, `email.outbox-show`, and `email.outbox-clear` in the `email` Console section, so you need access to that section. `email.outbox-clear` is destructive: `vitehub email outbox clear` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The `email.preview` operation renders a template through the same RPC. The written `vitehub email preview` command renders in your terminal without a server. The generated commands `vitehub email outbox list`, `outbox show`, and `outbox clear` print JSON.

## Read and reset Rate Limit counters

Read or reset one key's counter of a Rate Limit from `requireRateLimit()`:

```bash [Terminal]
pnpm vitehub rate-limit peek <id> <key>
pnpm vitehub rate-limit reset <id> <key> [--yes]
```

`<id>` is the stable ID of `requireRateLimit()`. `<key>` is the limited key, such as a client IP or user ID. Put `--` before a key that starts with a dash. Both commands take `--json`, `--url <url>`, and `--timeout <ms>`. Without `--url`, they call this project's dev server. With `--url https://app.example.com`, they call a deployed app with the [Console](/docs/development/console) on, and sign with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`.

The commands run `rate-limit.peek` (a read) and `rate-limit.reset` in the `rate-limits` Console section. `reset` is destructive: it asks for confirmation on a terminal and refuses elsewhere, so scripts pass `--yes`. The Console **Rate Limits** page uses the same operations.

- The memory provider keeps counters in the server process, so you see only the counters of the process that answers.
- The Cloudflare binding has only `limit()`, which uses a token, so both commands report `unsupported` and exit with status 1.

## Inspect Server Env

These commands report the status of declared Server Env values, without the values.

```bash [Terminal]
pnpm vitehub env inspect [--stage <name>] [--json]
pnpm vitehub env check [--stage <name>] [--json]
```

Both load the Vite config in the stage mode, with `.env.<stage>` files, and process values win. They list each declared variable with status, source, and required and secret flags. `env check` exits with status `1` when Server Env would fail to load, so it can gate CI or deploys.

## Generate and derive secrets

```bash [Terminal]
pnpm vitehub secret generate
VITEHUB_SECRET=... pnpm vitehub secret derive myapp:webhooks
pnpm vitehub secret console-key ci
```

`secret generate` prints 32 random bytes as base64 for [`VITEHUB_SECRET`](/docs/env/app-secret). `secret derive <purpose>` prints `deriveSecret(purpose)` for the `VITEHUB_SECRET` in the shell. `secret console-key [name]` prints a new Ed25519 key pair for [signed Console requests](/docs/development/console#sign-console-requests): the `VITEHUB_CONSOLE_KEY_<NAME>` line for the app and the `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>` line for the CLI. The name defaults to `CLI`. None of them loads the project.

## Inspect Definitions and Provider Output

`vitehub inspect` prints the summaries the Console shows, without a server or provider call. A Definition is the code that declares one resource, such as a queue or a rate limit. Each active package adds its own kind: `agent`, `auth`, `browser`, `channel`, `collection`, `content`, `database`, `queue`, `rate-limit`, `realtime`, `sandbox`, `schedule`, `workflow`, and `workspace`.

```bash [Terminal]
pnpm vitehub inspect definitions
pnpm vitehub inspect definitions --kind rate-limit
pnpm vitehub inspect definitions --json
```

```txt [Output]
Rate Limits (rate-limit): 1
  checkout  server/api/checkout.post.ts  [require-rate-limit]
    Limit: 10
    Window: 1m
    Enforcement: Strict
    Provider failure: Deny
    Source location: 4:9
```

`--json` prints `{ "definitions": [{ "kind", "label", "definitions": [...] }] }`. Each Definition has `name`, `file` (from the project root), `source`, and `fields`. An unknown `--kind` exits with status 1 and lists the kinds.

`inspect output` lists the Provider Output files (the files a build writes for the host) and shows which exist. Deployment paths use the host's output directory, such as `.output` or `.vercel/output`. Run a production build first.

```bash [Terminal]
pnpm build
pnpm vitehub inspect output
pnpm vitehub inspect output --json
```

`--json` includes the parsed content of each JSON file. The CLI redacts values under secret keys such as `token`, `secret`, `password`, or `apiKey`, every Worker `vars` value, and URLs with credentials. See [Provider output](/docs/reference/provider-output) for each file's owner and purpose.

`inspect resources` lists the host resource behind each Definition or store: D1 databases, Workers KV namespaces, R2 buckets, Cloudflare Queues, and the Vercel Blob store. Each entry shows the host, the resource kind, the Definition or store, the resource name, the binding, the id if one is known, and where the id came from. Like `inspect output`, it loads the configuration that a production build uses. It reads local files only and never calls a provider API.

```bash [Terminal]
pnpm vitehub inspect resources
pnpm vitehub inspect resources --json
```

```txt [Output]
cloudflare	cloudflare-d1	default
  Name: app-db
  Binding: DB
  Id: database-id
  Source: .vitehub/provision.json
cloudflare	cloudflare-r2-bucket	default
  Name: uploads
  Binding: BLOB
  Source: bound by name
```

| Source | Meaning |
| --- | --- |
| `config` | The Definition or the integration options set the id or the Vercel Blob token. |
| `env` | An env variable set the id. `env` names the variable. |
| `provision-state` | `vitehub provision run` recorded the id in `.vitehub/provision.json`. |
| `provider-output` | Only the generated Wrangler config of the last build names the id. |
| `name` | The host binds the resource by its name and needs no id, as for R2 buckets and Cloudflare Queues. |
| none | No id is known yet. Run `vitehub provision run` or set the id. |

For the Vercel Blob store, the id is `BLOB_STORE_ID`, which Vercel sets for the store connected to the project. Off Vercel, the store is reached through `BLOB_READ_WRITE_TOKEN`, and the CLI reports only whether the token is set, never its value. A configured `token` that overrides the environment is reported as `config`, without a store id or token value. `--json` prints `{ "resources": [...] }` with the same fields and the CLI redaction. D1 over HTTP, PostgreSQL Databases, and Definitions whose `cloudflare` value cannot be read statically are not listed.

Packages contribute inspection through `vitehub.inspect` on their Vite plugin. The owner package defines the summary; the CLI and the Console only render it. A package lists its host resources with `resources()`.

## Synchronize Channel webhooks

Deploy the stage before you register its Channel webhooks. `channels sync` loads the Agent Definitions for the Vite stage, checks that every webhook route is live at the exact public HTTPS origin, and compares the provider state. Telegram is the first supported provider.

The command only reads by default. Use `--json` to get a sanitized plan to review.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --json
```

Without `--url`, the command uses `vitehub({ publicUrl })` when it is one string. `--stage staging` loads stage env files such as `.env.staging`, and process environment values win. Keep the Telegram bot token and webhook secret in Server Env. The command takes no credential flags and never prints credentials.

To apply the plan, repeat the exact origin in `--confirm-origin`. This works without prompts, so developers, CI, and agents never pick a deployment by accident. The configured `publicUrl` needs no confirmation, but a `--confirm-origin` you add must match it.

```bash [Terminal]
pnpm vitehub channels sync \
  --stage staging \
  --url https://staging.example.com \
  --apply \
  --confirm-origin https://staging.example.com
```

`--agent <name>` or `--channel <id>` narrows an app with many Agents. Switching a Telegram Channel to polling, or setting `webhooks: false`, plans to remove its webhook. Applying that also needs `--allow-delete`, and the current provider URL must belong to the confirmed origin. ViteHub keeps pending updates during registration and removal.

Telegram's `getWebhookInfo` returns the URL and delivery errors, but not the secret token or allowed update list, so the plan marks those as unverifiable. Use `--force` to reapply them when the URL matches but credentials or subscriptions changed. Telegram accepts ports 443, 80, 88, and 8443. The CLI rejects other explicit ports before it applies.

`channels sync` only registers the webhook. The Telegram synchronizer subscribes to message updates, the one inbound event the built-in Channel supports. Admission rules, allowed users, secrets, and other update types stay in the app. An app that needs a custom adapter, certificate, fixed IP, or connection policy must manage the provider itself. An app-owned `adapter` is not synced.

## Export a Channel conversation

When the app has the Channel operations, `vitehub channels list` lists Channels and their retention, `channels threads` lists a Channel's threads, and `channels conversation` reads one thread's messages in order. `vitehub channels status <agent> <channel>` shows sync health and skipped messages of a [Gmail Channel](/docs/agents/gmail#failed-messages).

`conversations export` calls the `conversations.export` [operation](/docs/development/operations) on the dev server, or on the app at `--url` with the credentials of [Run any operation](#run-any-operation). It needs no webhook secret, only Console access to the `channels` section.

```bash [Terminal]
pnpm vitehub conversations export support telegram telegram:456 > chat.md
pnpm vitehub conversations export support telegram telegram:456 --format json --output ./chat --url https://app.example.com
```

Without `--output`, the text goes to stdout without attachments, and a retention warning goes to stderr. With `--output`, the directory must not exist. It gets the file (`history.json` or `<thread>.md`) and attachments in `media/`. `--media` and `--no-media` override the default. See [See and export a conversation](/docs/agents/channels#see-and-export-a-conversation).

## Download Channel history

`channels history` loads the stage's Agent and Channel configuration and calls the deployed webhook route with its webhook secret. Adapter-backed Channels use the Chat SDK export. A Channel with `history` exports its Collection items, takes repeatable `--query key=value` and optional `--thread`, and pages to the end. `--invocations` joins kept Invocations and recorded deliveries to each item.

The join uses `vitehub.channel.key` annotations first. For older Invocations, a Channel can give `history.invocationItem(invocation)`, which returns a history item or `undefined`, and the exporter calls `history.key()` and optional `history.thread()` on it. The journal keeps observations and run annotations, but not raw webhook input or trusted `input.context`, so recover only identities the kept data supports. A missing item, invalid key, or throwing hook leaves the Invocation unjoined. The exporter scans the journal once per Collection page. It never runs the Channel trigger or changes journal records.

```bash [Terminal]
pnpm vitehub channels history \
  --stage production \
  --url https://app.example.com \
  --agent calories \
  --channel telegram \
  --output ./channel-history
```

`--url` defaults to `vitehub({ publicUrl })` when it is one string. A Telegram direct-message Channel finds its thread when the adapter allows exactly one user. Pass `--thread <provider-thread-id>` for groups and for adapters where one Channel serves many conversations, issues, or tickets. When a Channel declares several webhook registrations, pick the route and its authentication with `--webhook <id>`.

`--webhook-path <path>` exports through another path on the confirmed origin, with the selected registration's authentication. Use it to reach the built-in route on an older deployment that does not serve a declared `webhooks.path` yet.

A custom Channel export holds the items of its history Collection. With `--invocations`, each item has `invocations` with `id`, `status`, `createdAt`, `updatedAt`, `dryRun`, `label`, `deliveries: [{ channel, text }]`, and optional final `text`. Delivery text is the validated reply before app formatting, including dry-run writes. To keep it, you need Invocation content storage or `metadataContent` with `channel.effect.content`.

A Chat SDK export holds only history the adapter or its State Adapter can give. Telegram's Bot API cannot backfill old messages, so it uses the `threadHistory` window: 100 messages kept for seven days by default. For a recovery archive, export before that window ends.

## Replay Channel history

`vitehub channels replay --agent support --channel mailbox --dry-run --label round-one --query folder=inbox` records each run with `triggeredBy: 'round-one'` and `vitehub.channel.key`. Repeat `--query key=value` for several values, as with `--filter`. Labels are not part of the history query. They must be non-empty, at most 512 characters. For a query field named `label`, use `--query label=value`.

Replay needs the development project token or deployed Console authentication. With `--url`, the command calls the `channels.replay` operation on the Console RPC of the deployed app, one page per call. The Agent must allow Console invocation. It checks saved items through the Channel trigger, without rechecking old provider signatures. Public webhooks still verify signatures. In `vite dev`, replay uses the host's Console journal, so local dry runs need no Invocation setup in the app.

## Manage Database migrations

The Database commands refresh the Database Definitions, then run Drizzle Kit. When every Database is named, ViteHub runs once per generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database generate --name add-audit-log
pnpm vitehub database generate --custom --name backfill-state
pnpm vitehub database generate --custom --schema-snapshot --name move-tables
pnpm vitehub database migrate
pnpm vitehub database up
```

`database up` converts each migrations folder of Drizzle Kit 0.x, with `meta/_journal.json`, to one folder per migration, as Drizzle Kit 1.0 writes them. `database generate` and `database migrate` refuse a 0.x folder with `DATABASE_MIGRATIONS_OLD_LAYOUT`.

`database generate` forwards Drizzle Kit arguments, supports `--name <name>` for a migration name, and uses `--custom` to create an empty custom migration. Drizzle Kit copies the previous snapshot into a custom migration, for SQL that changes only data. When the SQL changes the tables to the current Database Definitions, add `--schema-snapshot`: the migration then gets the snapshot of those Definitions, so the next `database generate` has nothing to add. `database migrate` accepts forwarded Drizzle Kit migration arguments.

## Export a Database

`database export` writes a SQL dump of each database, with no build. It reads the local SQLite file by default. `--remote` reads Cloudflare D1 (through the Cloudflare API), D1 HTTP, remote libSQL, or Postgres (through `pg_dump`).

```bash [Terminal]
pnpm vitehub database export
pnpm vitehub database export --remote --stage production --output backups/database.sql
```

| Option | Description |
| --- | --- |
| `--remote` | Read the remote database. Needed for a database that is not a local file. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Export only this database. |
| `--output <file>` | Write this file. Defaults to `.vitehub/exports/database/<name>-<local\|remote>-<time>.sql`. |

See [Export a database](/docs/database/configure#export-a-database) for each driver and the dump format.

## Seed a Database

`database seed` runs the seed file of each database, `server/databases/<name>/seed.ts`, with no build. Its default export gets `{ db, schema }`. It writes the local database by default, and refuses a database with pending migrations.

```bash [Terminal]
pnpm vitehub database seed
pnpm vitehub database seed --remote --stage staging --database analytics
```

| Option | Description |
| --- | --- |
| `--remote` | Write the remote database. Needed for a database that is not local. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Seed only this database. |

See [Seed data](/docs/database/configure#seed-data) for the seed file.

## Browse Database tables

`database tables` and `database rows` run `databases.tables` and `databases.browse`, the [operations](/docs/development/operations) of the Console Databases section. They read the running app's Database Definitions, so they work on SQLite, D1, libSQL, and Postgres without a Drizzle Kit config. They never write.

```bash [Terminal]
pnpm vitehub database tables
pnpm vitehub database rows users --limit 20 --sort email --direction desc
pnpm vitehub database rows users --search ada --json
pnpm vitehub database rows users --database analytics --offset 20 --url https://app.example.com
```

`database rows` reads at most 100 rows at a time and cuts cells at 32 KiB. `--offset` pages, `--sort <column>` and `--direction asc|desc` sort, and `--search <text>` matches any column. Without a table, it reads the tables only. A table that does not exist fails with `CONSOLE_NOT_FOUND`. `--database` picks a named database. Access needs the `databases` section, and `databases:read` is enough.

## Read and write KV keys

Start the dev server, then run `vitehub kv` in another terminal. Each command runs a `kv.*` [operation](/docs/development/operations) of the app, so it uses the app's keys. With `--url`, it runs on a deployed app with the Console on, using the credentials in [Run any operation](#run-any-operation).

```bash [Terminal]
pnpm vitehub kv list --prefix users: --limit 20
pnpm vitehub kv get settings
pnpm vitehub kv has settings
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv set session:42 active --ttl 3600
pnpm vitehub kv set template @./fixtures/template.txt
pnpm vitehub kv delete settings
```

Each write command prints what it changed:

```txt [Output]
Created key settings in store default (object).
Created key session:42 in store default (string, TTL 3600 s).
Deleted key settings from store default.
```

Every command takes `--store <name>`, `--json`, `--url <url>` when Vite does not listen on `http://localhost:5173`, and `--timeout <ms>`. Commands use the default KV store. `--store` picks a named store from `kv.stores`. An unknown store fails and lists the stores, `default` first.

- `list` prints one key per line. Use `--json` when keys contain line breaks. `--limit` defaults to 100, at most 1000. When more keys exist, stderr shows the `--cursor` for the next page. Some drivers count scanned entries toward the limit, so a page can hold fewer keys, or none, and still have a next cursor.
- `get` writes a string value unchanged, with no added newline, and other JSON values as formatted JSON. Binary values go to stdout as bytes, or as base64 with `"encoding": "base64"` in `--json` output. A missing key exits with status 1.
- `has` exits with status 0 when the key exists and 1 when it does not.
- `set` writes a string. `--json-value` parses the value as JSON. JSON input rejects values that underflow to zero or whose decimal size changes when parsed, so use strings for those and for integers outside JavaScript's safe range. A value that starts with `@` reads a UTF-8 file relative to the current directory. The output says if the key was created or updated.
- `--ttl <seconds>` on `set` sets an expiry, and takes positive fractional seconds. Cloudflare KV rounds up to whole seconds, at least 60. Upstash needs at least one second and rounds up to whole seconds. The output shows the real TTL and a notice when the driver changes it.
- `delete` says if the key was found. Deleting a missing key changes nothing and exits with status 0.

KV storage parses stored strings that look like JSON, so `"2026"` can read back as the number `2026`. There is no `clear` command, so each delete is explicit.

Errors go to stderr, or to `{ "error": { "code", "message" } }` on stdout with `--json`. Like the Console KV page, the commands print values as stored, without redaction. Do not store credentials in keys you inspect in shared logs.

The operations are `kv.list`, `kv.get`, `kv.has`, `kv.set`, and `kv.delete`, in the `kv` Console section. They run in the Nitro runtime and answer through the Console RPC, so you need access to the `kv` section. `kv.delete` is destructive: `vitehub kv delete` asks for confirmation on a terminal and refuses elsewhere. Scripts pass `--yes` (or `-y`). The Console KV page uses the same operations.


## Run a Decision

A Decision is a `defineChoices()` result that picks options from a text. `decisions list` finds files that call `defineChoices()`, loads them, and prints the exports that hold the result. It skips `node_modules`, `dist`, `build`, `coverage`, and dot folders. There is no registry: the file path is the address. A file that fails to load is listed with its error, and the command exits with status `1`.

```sh
pnpm vitehub decisions list
```

```txt [Output]
FILE                              EXPORT    NAME
server/utils/forecast-choices.ts  forecast  forecast

Run one with: vitehub decisions run server/utils/forecast-choices.ts "<text>"
```

`decisions run <file> <text>` loads the file, calls `resolve()` with the text, and prints the selection as JSON. It calls the definition's gateway, so it reads the app's keys, such as `AI_GATEWAY_API_KEY` or `TYPESAFE_API_KEY`, from the shell or the project's `.env` files. `--inspect` prints the questions and state that `resolve()` would send, without a model call.

```sh
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts except vak supply"
pnpm vitehub decisions run server/utils/forecast-choices.ts "nord parts" --inspect
```

The first command's output, with the offline gateway of the [Decisions tutorial](/docs/decisions/get-started):

```json [Output]
{
  "supplier": { "exclude": ["vak"], "include": ["nord"] },
  "chart": { "confidence": 0.8, "ranked": [{ "probability": 0.1, "value": "line" }, { "probability": 0.1, "value": "bar" }], "value": null }
}
```

| Option | Meaning |
| --- | --- |
| `--export <name>` | The export to run when the file has more than one `defineChoices()` export. |
| `--context <json>` | The `context` for `options` functions, such as `'{"tenantId":"t1"}'`. |
| `--inspect` | Print the plan of `inspect()` instead of calling the gateway. |
| `--json` | `decisions list` only: print the files as JSON. |

A Decision error prints `{ "error": { "code", "message" } }` and exits with status `1`. The command loads the file with Vite but without the project config, so imports must use relative paths or package names. Nuxt aliases such as `~~` and auto-imports do not work. See [Decisions server API](/docs/decisions/server-api) for `resolve()` and `inspect()`.

## Check and move translations

`vitehub i18n status` reads `t`, `<Trans>`, `plural`, `select`, and `msg` in the code, and compares them with the records in `locales/<locale>/`. It prints, per locale, the number of messages, translated messages, missing messages, and unused records. It needs no dev server and changes no file.

```bash [Terminal]
pnpm vitehub i18n status --json
pnpm vitehub i18n export es --output es.po
pnpm vitehub i18n import es es.po
pnpm vitehub i18n prune --yes
```

`export` writes a PO file for Poedit or a translation service. `import` saves its translations as records. `prune` deletes the records of messages that the code no longer has. Without `--yes`, it only lists them. Read [Translate your first page](/docs/i18n/get-started) for the full flow.

## Run app tasks

A task is a [Nitro task](https://nitro.build/docs/tasks): a file in `server/tasks/` that default-exports `defineTask()`. Use tasks for seeds, backfills, data repair, and one-off admin jobs. `vitehub()` registers each file and turns on Nitro tasks, so you do not set `nitro.serverDir` or `nitro.experimental.tasks`. The task name is the path with `/` replaced by `:`, so `server/tasks/db/seed.ts` is `db:seed`.

This seed task adds a row to the `notes` table of the default Database:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      title: text('title').notNull(),
    }),
  },
})
```

```ts [server/tasks/db/seed.ts]
import { useDatabase } from 'vite-hub/database'
import { defineTask } from 'nitro/task'

export default defineTask({
  meta: { description: 'Add one demo note' },
  async run({ payload }) {
    const { db, schema } = useDatabase('default')
    const title = typeof payload.title === 'string' ? payload.title : 'Hello'
    const [note] = await db.insert(schema.notes).values({ title }).returning()
    return { result: note }
  },
})
```

Start the dev server, then run the task in another terminal. It runs in that server's Nitro runtime, so `useDatabase()`, `kv`, `blob`, and `env` get the same bindings as a request.

```bash [Terminal]
pnpm vitehub task list
pnpm vitehub task run db:seed '{"title":"First note"}' --yes
pnpm vitehub task run db:seed '{"title":"First note","count":3}' --json --yes
pnpm vitehub task run db:seed --url https://app.example.com --yes
```

```json [Output]
{
  "tasks": [
    { "description": "Add one demo note", "name": "db:seed" }
  ]
}
{
  "durationMs": 14,
  "name": "db:seed",
  "result": { "id": 1, "title": "First note" }
}
```

- The argument after the task name is the payload, a JSON object. Without it the payload is `{}`. `--input '{"name":"db:seed","payload":{...}}'` or `--input @file.json` passes the whole input.
- The command prints the name, `durationMs`, and the `result` from `run()`. A task that throws exits with status 1 and `TASK_FAILED`. The message goes to stderr, or to `{ "error": { "code", "message", "fix" } }` with `--json`. The server log shows the stack.
- An unknown name fails with `TASK_NOT_FOUND`. A task file without `run()` fails with `TASK_NOT_IMPLEMENTED`.
- Nitro runs one instance of a task name at a time per server. A second run while the first is active gets the first run's result.

`vitehub inspect definitions --kind task` lists the files in `server/tasks/` with no server. `task list` asks the running app, so it also shows tasks that `nitro.tasks` declares in the Vite config.

`task list` and `task run` are the `task.list` and `task.run` [operations](/docs/development/operations) in the `tasks` section. They exist when the app has task files or declares `nitro.tasks`. A generated Nitro plugin gives them Nitro's registry, so they also work on a deployment with `--url` and the Console credentials (`task run` needs `console.invoke`). `task run` is `destructive`, so it asks for `--yes`. The `tasks` section has no Console page. Grant it in `console.authorize` with `sections: ['tasks']`, or `'tasks:read'` for listing only.

> [!WARNING]
> A task can change anything the app can. Give `tasks` only to people who may run a seed or a backfill.

`vitehub task` does not support Nuxt, because Nuxt runs its own Nitro and scans `server/tasks` itself when `nitro.experimental.tasks` is on.

Set `nitro: { experimental: { tasks: false } }` to turn tasks off. A task that `nitro.tasks` declares keeps its handler and description.

## Edit and publish Content

Start the dev server, then run `vitehub content` in another terminal. Each command runs a `content.*` [operation](/docs/development/operations) with the app's `server/content.ts`, so it sees the app's drafts and published documents.

```bash [Terminal]
pnpm vitehub content collections
pnpm vitehub content list posts
pnpm vitehub content edit posts hello
pnpm vitehub content diff posts hello
pnpm vitehub content publish --collection posts --id hello
pnpm vitehub content schedule --collection posts --id hello --at 2026-10-20T09:00:00+02:00
```

- `edit` opens the draft in `$EDITOR`, or saves `--file`, and prints the draft's field issues. While another session holds the edit lease, it fails with `CONTENT_LEASE_HELD`, unless you pass `--override-lease`.
- `publish` and `schedule` list the pending changes with their draft digests (content hashes), ask for confirmation, and pin exactly those digests. If a draft is saved in between, the command fails and nothing is published. `--yes` skips the prompt, and `--dry-run` only lists the changes. Without an interactive terminal, they need `--yes`.
- Omit the id for a singleton.

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. Without `--url`, it calls this project's dev server (see [Run any operation](#run-any-operation)). With `--url`, it calls a deployed app with the Console on, using the credentials from [the table below](#inspect-and-cancel-on-a-deployed-app). See [Content CLI](/docs/content/cli) for each command's output.

## Run any operation

Every package [operation](/docs/development/operations) is also a command: `vitehub <namespace> <command> [positional] [--key value]`. The namespace is the operation section (or its `cli.namespace`), and the command is its verb (or its `cli.command`), so `agents.list` is `vitehub agents list`. `vitehub inspect definitions --kind operation` lists each operation and its command. `vitehub <namespace> <command> --help` shows the input.

```bash [Terminal]
pnpm vitehub agents list
pnpm vitehub agents status --agent support
pnpm vitehub invocations list --limit 10
pnpm vitehub invocations get ainv_123 --json
pnpm vitehub invocations delete ainv_123 --yes
pnpm vitehub invocations list --url https://app.example.com
```

The generated commands need the Console RPC. `vitehub()` installs it. Standalone `hubKV()`, `hubBlob()`, `hubEmail()`, and `hubRateLimit()` install a local development RPC for their storage commands. Other standalone plugins, such as `hubWorkflow()`, `hubSchedule()`, and `hubQueue()`, need a running app with an operation RPC.

Operations that run app code (`workflow.start`, `workflow.resume`, `queue.send`, `task.run`, `schedule.run`, and `schedule.start`) exist only when `console.invoke` is on. It is on in development and off in a production build, so on a deployment these commands answer "Console operation not found" until you set `console: { invoke: true }`. `task.run` is `destructive`: the command asks for `--yes`, and agents and MCP need approval.

The built-in commands are `vitehub agents list|invoke|status`, `vitehub invocations list|get|cancel|undo|delete|workspace|capabilities`, `vitehub blob list`, `vitehub kv list|get|has|set|delete`, `vitehub database tables|rows`, `vitehub definitions list`, `vitehub env get`, `vitehub project info`, `vitehub search query`, `vitehub sections list`, `vitehub agent usage`, `vitehub documents action`, and `vitehub media action`. `vitehub task list|run` come from the task plugin, and `vitehub queue list|send` from the Queue package. A hand-written command of the same name, such as `vitehub blob list`, wins.

| Option | Use it for |
| --- | --- |
| `--json` | Print JSON, also for a failure: `{ "error": { "code", "message", "fix" } }`. |
| `--yes` | Delete or publish without asking. Without it, a terminal asks first, and no terminal fails. A call marked read only (`readOnlyWhen`), such as `content publish --dry-run`, needs no `--yes`. |
| `--url <origin>` | Call a deployed app with the credentials in the table below. |
| `--input <json>` or `--input @file.json` | Pass the whole input. Flags and positional arguments override it. |
| `--timeout <ms>` | Wait this long for the answer. |

Flags come from the input's JSON Schema:

- A number, whole number, boolean, or string takes its text.
- A list takes repeated flags or commas (`--tags a,b`).
- An object, an unknown value, or a list of objects takes JSON (`--body '{"a":1}'`).
- A nullable value takes the text `null`. A `string | number` input stays a string.
- `url`, `timeout`, `json`, `yes`, and `input` are reserved and cannot be input keys.

Without `--url`, a command calls its own project's dev server, found in `.vitehub/dev-server.json` (`{ url, root }`). The dev server writes this file when it listens and removes it when it closes. Without it, the command uses `VITEHUB_DEV_SERVER_URL`. With neither, it fails with `CLI_R0005`. It never guesses `localhost:5173`, because another project may use that port. The dev RPC names its project in a response header, and the command stops with `INTERNAL_R0025` when it is another project. A Nuxt dev server does not write the file, so pass `--url` or set `VITEHUB_DEV_SERVER_URL`.

A command does not sign its calls to the dev server that it finds. When that dev server takes only [signed calls](/docs/development/console#sign-console-requests), as with `console: true`, the command fails with `401`, and its fix names the `--url` to pass. With `--url`, the command signs its calls to the dev server too.

A failed command prints `<code>: <message>` and a `Fix:` line on stderr, and exits with `1`. A bad flag value fails with `CLI_R0003` and the usage line. Two operations with the same namespace and command fail the build and the CLI load with `INTERNAL_B0049`. A hand-written command with the same name as a generated one runs instead, as `vitehub content edit` does.

## Run a Schedule on demand

`schedule run` starts a Static Schedule Definition that sets `manual: true`, and prints the run status, duration, run id, and scheduled time. `--json` prints the run record. A failed run still exits with `0`, so read `status` or `error`. An unknown name fails with `SCHEDULE_DEFINITION_NOT_FOUND` (`404`). A definition without `manual: true` fails with `SCHEDULE_MANUAL_RUN_DISABLED` (`403`).

```bash [Terminal]
pnpm vitehub schedule run sync
pnpm vitehub schedule run sync --at 2026-01-31T23:59:00Z
pnpm vitehub schedule run sync --url https://app.example.com
```

`--at` runs the definition as if its cron fired at that time, without checking the cron. The handler gets it as `scheduledAt`, and `vitehub schedule runs <name>` lists the run under it. Use it to test code that depends on the fire time, such as a job near midnight or on a month's last day. The value is an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00+01:00`. No time zone, a date only, or a day that does not exist (`2026-02-30`) fails with `SCHEDULE_INVALID_SCHEDULED_AT` (`400`), and nothing runs.

`schedule run` is the `schedule.run` [operation](/docs/development/operations) of the Schedules section. Without `--url`, the dev server runs the definition in its Nitro runtime, with the app's Nitro plugins and dev bindings, and the run shows in `vitehub schedule runs <name>`. With `--url`, it calls the deployment with the [credentials below](#inspect-and-cancel-on-a-deployed-app). The deployment runs only definitions that the [Console](/docs/development/console) installed with `invoke: true`, which is on in development and off in a production build.

A CI job needs no Console login. Make a key pair with `vitehub secret console-key ci`, set `VITEHUB_CONSOLE_KEY_CI` on the app with `console: true`, and set `VITEHUB_CONSOLE_PRIVATE_KEY_CI` as a secret of the job. `vitehub schedule run <name> --url <origin>` then [signs the call](/docs/development/console#sign-console-requests), the same as every other command with `--url`.

The Console Schedules page runs the same operation. A read-only grant (`"schedules:read"`) can list runs but cannot run a Schedule.

## Run and inspect Schedules

Start the dev server, then run `vitehub schedule` in another terminal. `runs` and `attempts` read that server's Schedule Run store, so they show the runs the app recorded: manual runs and Process Runtime runs.

```bash [Terminal]
pnpm vitehub schedule runs digest --limit 5
pnpm vitehub schedule runs digest --json
pnpm vitehub schedule attempts srun_static_digest_2026-05-22T07:00:00.000Z
```

```txt [Output]
RUN                                          STATUS     SCHEDULED AT              ATTEMPTS  ERROR
srun_static_digest_2026-05-22T07:00:00.000Z  succeeded  2026-05-22T07:00:00.000Z  1         -
```

`list`, `start`, and `cancel` work on the Schedules that code starts with [`startSchedule()`](/docs/schedule/server-api#start-a-schedule-from-code). The Definition has no `cron`. `start` takes `--at` for one run, or `--cron` and `--time-zone` for a repeating one. To pass a payload, give the whole input as JSON with `--input`.

```bash [Terminal]
pnpm vitehub schedule start reminder --at 2026-11-08T09:00:00Z
pnpm vitehub schedule start reminder --input '{"name":"reminder","cron":"0 9 * * 1-5","timeZone":"Europe/Madrid","payload":{"text":"Stand-up"}}'
pnpm vitehub schedule list
pnpm vitehub schedule runs sched_mh1x2y3z_ab12cd34
pnpm vitehub schedule cancel sched_mh1x2y3z_ab12cd34 --yes
```

Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. `runs` takes `--limit <n>`. Errors go to stderr, or to the JSON body with `--json`. `schedule.runs` and `schedule.attempts` are `read` operations of the Schedules section.

The output redacts URLs with credentials, bearer tokens, and secret assignments in error messages. When the store cannot list the full history, the command fails with `SCHEDULE_HISTORY_INCOMPLETE` (`503`). An unknown run id fails with `SCHEDULE_RUN_NOT_FOUND` (`404`).

## Run Agent Evals

Use `vitehub agent eval` to test what an Agent does, not only its types.
Evals need test-only dependencies, so install them before you write one.
An optional path runs only one eval file.

```bash [Terminal]
pnpm add -D @vite-hub/agent evalite vitest
```

```bash [Terminal]
pnpm vitehub agent eval
pnpm vitehub agent eval server/agents/support.eval.ts --threshold 90
pnpm vitehub agent eval --output .vitehub/evals/support.json --hide-table
pnpm vitehub agent eval --watch
pnpm vitehub agent eval --no-cache
```

`--watch` reruns affected evals on file changes. `--no-cache` skips cached model output. For slow evals, set `agent.eval.testTimeout` in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`.

## Inspect an Agent Definition

Start the dev server, then print the resolved metadata of one Agent Definition.
The command does not run the Agent.

```bash [Terminal]
pnpm vitehub agent info --agent support
pnpm vitehub agent info --agent support --json
```

The output shows the Driver (the code that runs the Agent), its execution authority, tools, visible Workspace files and Sources, instructions, Invoker Profiles, warnings, and metadata status.
Execution authority is a snapshot of what the Agent can reach: filesystem, network, environment, credentials, processes, and isolation. `unknown` means the runtime or provider cannot prove that part during inspection. It does not mean restricted or denied. The snapshot describes the inspected context. It is not an enforcement decision or proof of safety.
`--json` gives the structured contract at `config.driver.executionAuthority`. Use `--url` when Vite is not on `http://localhost:5173`.
With more than one Agent, `--agent` is required.
`agent info` reads from the guarded Agent Dev Loop endpoint of `hubAgent()`.

`agent info`, `agent dev`, and `channels replay` send a private token to this endpoint. The dev server stores the token with user-only permissions outside the served project, and the CLI reads it locally. The discovery request needs no token. It returns Agent names, aliases, trigger names, the server root, and the token server ID, but not the token. Without the token, the endpoint rejects Agent inspection, messages, Capability CLI calls, Workspace commands, and Channel replay, also on a server exposed with `--host`. Run these commands on the dev server's machine.

## Cancel an Agent Invocation

Start the Vite + Nitro dev server, then cancel one pending or running Agent Invocation by its journal id.

```bash [Terminal]
pnpm vitehub agent invocations cancel ainv_0123
pnpm vitehub agent invocations cancel ainv_0123 --json
```

```txt [Output]
ainv_0123 cancel requested, not enforced by run
```

`hubAgent()` adds a guarded `/__vitehub/agent/invocations/dev` endpoint to the dev server. It forwards the request into the Nitro dev environment, where the Agent Definitions and `invocations` journals are the same objects that run the app's Invocations. So the cancel reaches the running Invocation with any store, including `createMemoryAgentInvocationStore()`. The endpoint accepts only local hosts and same-origin requests. Use `--server` or `VITEHUB_DEV_SERVER_URL` when Vite is not on `http://localhost:5173`, and `--timeout` to change the timeout. With `--url`, the command cancels through the app's Console instead.

Nuxt runs Nitro outside the Vite process, and plain Vite has no Nitro. There the endpoint returns `501`, and the command prints the reason and exits with status 1.

| Output | Meaning | Exit status |
| --- | --- | --- |
| `cancel requested` | A run in the Nitro runtime got an abort signal. Its final journal state shows whether it stopped. | 0 |
| `cancel request recorded; execution stop is unconfirmed` | The journal kept the request for a current or future owner. A crashed owner sees it only after execution recovery. | 0 |
| `cancel requested, not enforced by <driver>` | The Driver cannot enforce an abort. Delivery does not confirm that its owner got the request. | 0 |
| `already <status>` | The Invocation already finished. | 0 for `cancelled`; 1 for `completed` or `failed` |
| `not found` | The journal has no Invocation with this id. | 1 |

`--json` prints the `AgentInvocationCancelResult` from `invocations.cancel(id)`.

### Inspect and cancel on a deployed app

Pass the app URL with `--url` to list, show, follow, or cancel Invocations through its [Console](/docs/development/console). The Console must be on, and `cancel` also needs `invoke: true`, like the Console cancel button. The command does not load the project config, so a local config error cannot stop it.

```bash [Terminal]
export VITEHUB_CONSOLE_PRIVATE_KEY_CI='<private key>'
pnpm vitehub agent invocations list --url https://app.example.com --status running
pnpm vitehub agent invocations show ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations tail ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations cancel ainv_0123 --url https://app.example.com
pnpm vitehub agent invocations undo ainv_0123 --change chg_… --url https://app.example.com
```

`show` prints the changes an Agent made on a person's page through the [page Capability](/docs/agents/capabilities/page), with `--json` in `pageChanges` and `approvals`. `undo <id> --change <change>` asks that page, while it is open, to put one change back. It sends no value: the page restores its own record and keeps a value the person changed after the Agent. It exits 1 when the page could not put the value back.

Each command posts one birpc call to `/_vitehub/rpc` under the app URL, and [signs](/docs/development/console#sign-console-requests) it with the key in `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`, a private key from `vitehub secret console-key`. The command signs as the key `<NAME>`. Set only one.

`--url` is the app URL, as in every `vitehub` command: `https://app.example.com`, or `http://localhost:3000` for a local production build or a dev server. Remote URLs must use HTTPS, without credentials, a query, or a fragment. The command does not follow redirects. A `401` or a redirect reports a refused signature.

Two old forms still work until the next minor version, and print `AGENT_R1053`: a Console URL, such as `http://localhost:3000/_vitehub`, and a localhost URL with no Console, which the command reads as a local invocation endpoint, or as the dev server for `cancel`. Pass the app URL instead, or `--server` for the dev server.

The Console has no status filter, so `list --status` reads pages until it has `--limit` matches (default 50). `tail` asks only for observations after the last one it printed. Cancel outcomes and exit statuses are the same as in development.

## Talk to an Agent during development

Start the dev server, then attach the Agent Dev Loop from another terminal.

```bash [Terminal]
pnpm vitehub agent dev --agent support --url http://localhost:5173
```

Pass a message or `--prompt` for one invocation, or neither for an interactive session.

```bash [Terminal]
pnpm vitehub agent dev "/summary" --agent support
pnpm vitehub agent dev --agent support --prompt "/summary"
pnpm vitehub agent dev --agent support -p "/summary"
```

Use `--input` when the invocation needs event input that would normally come from a Channel, route, webhook, or app transport.
Pass the JSON object inline, or `@<file>` to read it from a file. The file can live anywhere in the app, but colocating it as `server/agents/<agent>/dev.payload.json` keeps local fixtures next to the Agent Definition without making them part of production behavior.
It must contain one JSON object shaped for the selected Agent Trigger.
For non-chat triggers, pass `--trigger` and shape the object for that trigger instead of Agent Invocation Context Values.

```json [server/agents/support/dev.payload.json]
{
  "user": {
    "id": "user_123",
    "name": "Local Developer"
  },
  "session": {
    "id": "local-support"
  },
  "meta": {
    "audience": "technical"
  }
}
```

```bash [Terminal]
pnpm vitehub agent dev --agent support --input @server/agents/support/dev.payload.json
pnpm vitehub agent dev --agent support --input @server/agents/support/dev.payload.json -p "/summary"
pnpm vitehub agent dev --agent support --input '{"user":{"id":"user_123"}}'
pnpm vitehub agent dev --agent support --timeout 180000 -p "/summary"
```

Use `--cli` when a Capability (a feature added to the Agent) declares its own CLI.
Everything after `--` is the Capability CLI command.
The Agent Dev Loop has these commands by default, also for provider-backed Agents. `defineAgent({ cli: { capabilities: false } })` hides them.
During Agent runs, ViteHub shows operation tool calls as command lines, such as `api listCustomers --query '{"status":"active"}'`, not as raw input objects.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

The output shows the payload file path before the Agent Invocation starts.
In interactive mode, type a message or command such as `/summary`.

```txt [Output]
Loaded payload: /Users/acme/app/server/agents/support/dev.payload.json
Connected to support at http://localhost:5173
> /summary
```

Start input with `!` to run a shell command in the Agent's Workspace (its file system).
The Agent must declare a writable Workspace.
ViteHub runs the command in a Workspace Session and commits successful changes to the Workspace Store.

```bash [Terminal]
pnpm vitehub agent dev --agent support "!pnpm test"
pnpm vitehub agent dev --url http://localhost:5173 --timeout 180000 support !pnpm test --filter api
```

Put Agent Dev Loop options before the `!` command. Flags after `!` go to the Workspace command.
In interactive mode, `!` input skips the Agent for that turn.
Use normal messages for the Agent, `!` for Workspace shell work, and `--cli` for Capability commands.

```txt [Output]
Connected to support at http://localhost:5173
> !pnpm test
```

## Run Workspace commands during development

Use `vitehub workspace dev` to run a command in a Workspace without an Agent.
Start the dev server, then run it in another terminal.

```bash [Terminal]
pnpm vitehub workspace dev --url http://localhost:5173 docs exec pnpm test --filter api
pnpm vitehub workspace dev --timeout 180000 docs exec "npm run lint"
pnpm vitehub workspace dev --path guides --path examples docs exec pnpm test
```

The command runs through the Workspace dev endpoint of `hubWorkspace()` on the Compatible Vite Development Server.
ViteHub creates a Workspace Session, runs the command, prints stdout and stderr, and commits the session when the command succeeds.
Put options before the Workspace target, and `exec` before one-shot command args.
Repeat `--path <path>` to load only those paths into the session.
Without a command in an interactive terminal, the CLI opens a prompt for repeated commands.

```txt [Output]
Connected to docs at http://localhost:5173
> pnpm test
```

## Work on Workspace files in a local folder

`vitehub pull` and `vitehub push` keep a folder of the project in sync with one ref of a Workspace, as `git pull` and `git push` do with a branch. Edit the files in your editor, and edit the same ref in the Console. The first pull names the folder and the ref and writes `vitehub.lock`; commit that file. See [Work on a ref in a local folder](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder).

```bash [Terminal]
pnpm vitehub pull site --dir content --ref draft --url https://docs.example.com
pnpm vitehub pull --dry-run
pnpm vitehub push --message "Fix the install guide"
```

Run `pnpm vitehub hooks install` once to check for conflicts before each commit and to push the checkout folders when you push the default branch. A push of another branch leaves the remote ref alone, so work in progress does not reach the shared draft. The Workspace push updates `vitehub.lock`, and Git cannot add it to a push that already started, so the hook stops that Git push. Commit `vitehub.lock` and any pulled files, then run `git push` again. Skip the hooks for one Git command with `--no-verify`.

## Read Workspace history during development

`vitehub workspace history`, `refs`, and `show` read a Workspace's [retained history](/docs/workspace/server-api#retained-folder-history): its refs, such as `draft` and `published`, and the revisions on each. Run them next to the dev server, or pass `--url <origin>` for a deployed app. They only read, and never commit or move a ref.

```bash [Terminal]
pnpm vitehub workspace history content
pnpm vitehub workspace history content --ref draft --limit 10
pnpm vitehub workspace refs content
pnpm vitehub workspace show content draft
pnpm vitehub workspace show content published posts/hello.md
pnpm vitehub workspace show content 9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a posts/hello.md
```

```txt [Output]
REVISION                                                          REF        CREATED AT                AUTHOR  FILES  MESSAGE
bc4cf2341f4244c405de80d58ff6b53b5855b27e22dfb9b61567c9cfc44a4f3d  draft      2026-10-15T12:12:47.744Z  maxi    2      Edit hello
9a97b4caf7ed04dd7d590ab9192ee21211375d0fb7652c586bd506049bd39f3a  published  2026-10-15T12:12:47.733Z  editor  1      Publish hello
c08f4415a5303b77a6a0e58436b885215950ed298e3e6cebbc85c18f2b97edb9  draft      2026-10-15T12:12:47.727Z  maxi    2      Save hello
8d104bde6b19e80361256ab8f6f0bfee81c2756210c864c5db1ea95a25e40d0f  main       2026-10-15T12:12:47.716Z  -       1      Start content
```

- `history <workspace>` lists revisions newest first. Without `--ref`, it merges all refs and shows the newest `--limit` revisions (default `20`, at most `100`). With `--ref <ref>`, it lists one ref and prints the `--cursor` of the next page.
- `refs <workspace>` lists each ref with its head revision.
- `show <workspace> <ref|revision> [path]` takes a ref name or full revision id. A ref name wins when both match. Without a path, it prints the revision and its files with size, media type, and SHA-256 digest. With a file path, it prints the file as it was then, so you can redirect it. A binary file prints a notice instead, and `--json` returns its bytes as `base64`. With a directory path, it lists the files under it.

`AUTHOR` is the revision `metadata.author`, or `-`. Times are ISO 8601 UTC. Blob + Database revision ids are SHA-256 digests of the revision manifest. Every command takes `--json`, `--url <origin>`, and `--timeout <ms>`. With `--json`, the CLI prints revision objects with `id`, `ref`, `parentId`, `createdAt`, `message`, `metadata`, `author`, `files`, and `bytes`, and `show` returns content as `utf8` text or `base64` bytes. Errors go to stderr, or to the JSON body with `--json`, with exit status 1.

A Workspace whose Store keeps no revisions fails with `WORKSPACE_R0069` and names the [Blob + Database Store](/docs/workspace/configure#blob-database-store), which keeps refs and revisions.

The commands are the `workspace.history`, `workspace.refs`, and `workspace.show` [operations](/docs/development/operations) of the Workspaces section. They run in the app's Nitro runtime, so they work on the dev server and on a deployed app. All three read, so `console.authorize` grants them with `workspaces` or `workspaces:read`.

## Preview provisioning

Use `--dry-run` before you create provider resources.
Provision never deletes or changes existing resources. It writes non-secret ids only when a real run applies actions.

```bash [Terminal]
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... pnpm vitehub provision run --provider cloudflare --dry-run
VERCEL_TOKEN=... VERCEL_PROJECT_ID=... pnpm vitehub provision run --provider vercel --dry-run
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `Unknown ViteHub CLI namespace` | The package plugin is missing or off. | Turn the feature on in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`, or add the package's `hubX()` plugin to `vite.config.ts`. |
| `Unknown Definition kind` | No active package has that kind. | Use a kind from the printed list, or turn on the package. |
| `Provision requires --provider cloudflare\|vercel` | The provider flag is missing or misspelled. | Pass a supported provider explicitly. |
| Provision fails before applying actions | Required provider credentials are missing. | Set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, or set `VERCEL_TOKEN`. |
| Provision dry-run reports no actions | A package plan skipped the provider lookup, because its read credentials are missing. | Set the provider credentials. `--dry-run` still blocks `apply()`. |
| Vercel Provision reports no resources for Blob | `VERCEL_PROJECT_ID` is missing, or the Blob store is not `vercel-blob`. | Set the project id and the Vercel Blob driver, then run again. |
| Agent eval CLI is disabled | `agent.eval` or `agent.cli` turns off the eval runner. | Turn the option back on for local development. |
| Agent eval times out | The eval case, model call, or provider run takes longer than `agent.eval.testTimeout`. | Raise `agent.eval.testTimeout` in `nuxt.config.ts` or `vite.config.ts`, or make the case smaller. |
| Vite config fails to load a ViteHub plugin import | A new npm project loads `vite.config.ts` as CommonJS, but ViteHub packages are ESM-only. | Set `"type": "module"` in `package.json` or rename the config to `vite.config.mts`. |
| `No Compatible Vite Development Server found` | The dev server is not running, or `--url` has the wrong port. | Start Vite, then pass the dev server URL. |
| `CLI_R0005` from an operation command | No dev server wrote `.vitehub/dev-server.json`, and `VITEHUB_DEV_SERVER_URL` is not set. | Start `vite dev` in this project, or pass `--url`. |
| `INTERNAL_R0025` from an operation command | The server at the URL runs another project. | Start `vite dev` in this project, or pass the right `--url`. |
| `CLI_R0003: --url is the app URL, not the Console URL` | `--url` has a `/_vitehub` path. | Pass the app URL that the message names. The command adds the Console path. |
| `AGENT_R1053` from `vitehub agent invocations` | `--url` is a Console URL, or a localhost URL with no Console. This old form stops working in the next minor version. | Pass the app URL, or `--server <url>` for the dev server. |
| `INTERNAL_R0024` from an operation command | The command could not reach the app, or the app refused the signature. | Start `vite dev`, or pass `--url` and set `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. |
| `vitehub schedule run` fails with `SCHEDULE_DEFINITION_NOT_FOUND` | The Definition does not set `manual: true`, is not found, or the Console did not install it because `console.invoke` is off. | Set `manual: true`, and keep `console.invoke` on. |
| `vitehub schedule run` fails with `SCHEDULE_MANUAL_RUN_DISABLED` | The Definition exists but does not set `manual: true`. | Set `manual: true` in `defineSchedule()`. |
| `vitehub schedule run --at` fails with `SCHEDULE_INVALID_SCHEDULED_AT` | The time has no time zone or no time, or the day does not exist. | Pass an ISO 8601 date-time with `Z` or an offset, such as `2026-01-31T23:59:00Z`. |
| `Unknown Workspace Dev target` | The dev server did not find that Workspace. | Check the Workspace Definition name and that `hubWorkspace()` is active. |
| `Agent Dev Loop command requires workspace.mode: "write"` | A `!` command targeted an Agent without a writable Workspace. | Give the Agent `workspace: { mode: 'write' }`, or send a normal message. |
| Agent Dev Loop request times out | A streamed invocation sent no events before the inactivity timeout, or a Capability CLI or Workspace command passed its deadline. | Pass `--timeout <ms>`, or look at the stalled work. |
| `Agent Dev Loop --input must be a JSON object` | The `--input` value or file is not a JSON object. | Pass one object shaped for the selected Agent Trigger. |

## Next steps

- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.

## Run Workflows in development

Turn on `hubWorkflow()` and start the dev server.

```bash [Terminal]
pnpm vitehub workflow start welcome '{"name":"Ada"}'
pnpm vitehub workflow get <runId>
pnpm vitehub workflow cancel <runId> --yes
pnpm vitehub workflow resume <token> '{"approved":true}'
pnpm vitehub workflow runs list --status failed
pnpm vitehub workflow runs show <runId>
pnpm vitehub workflow runs clear --yes
```

The commands are generated from the `workflow.start`, `workflow.get`, `workflow.cancel`, and `workflow.resume` [operations](/docs/development/operations). They call the Console RPC of the running app, so app and CLI runs share state, and `--url <origin>` calls a deployed app that serves the Console RPC. The argument after the Workflow name or token is the payload, a JSON value; `--input '{"workflow":"welcome","payload":{...}}'` or `--input @file.json` passes the whole input. `cancel` and `runs clear` ask for confirmation unless you pass `--yes`. All commands accept `--json`, `--url`, and `--timeout`. A run that this runtime did not start needs `--workflow <name>` for `get` and `cancel`. A `console.authorize` grant of `workflows` allows them all; `workflows:read` allows only `get`, `runs list`, and `runs show`.

Inline runs can be read with `get` for five minutes. Inline cancellation, Cloudflare cancellation and resume, and OpenWorkflow resume return unsupported-operation errors. OpenWorkflow starts enqueue work and require a worker to execute it. Resume uses an opaque hook token, not a run ID or signal name.

### Inspect runs in development

`vite dev` records every inline run: the runs that `vitehub workflow start`, the Console, and app code start. `vitehub workflow runs list` lists them newest first, with their status and step count. Filter with `--workflow <name>`, `--status queued|running|completed|failed`, and `--limit <n>`. `vitehub workflow runs show <runId>` prints the run with each step, its status and times, the error of a failed step, and the result of the run. Add `--json` for the step outputs. Credentials in results, outputs, and error messages are redacted. `vitehub workflow runs clear --yes` removes all recorded runs and prints how many it removed, so a test or an agent can start from an empty history without a restart. It does not cancel active runs and does not change what `get` returns.

The history lives in the memory of the dev server. It keeps the newest 200 runs and is empty after a restart or `runs clear`. It records the steps of a folder Workflow, the numbered files that run through `steps`. Inline runs do not retry a failed step, so each step runs once. The history records inline runs only: a run that a Cloudflare Workflow binding, OpenWorkflow storage, or a native Vercel Workflow starts is not in it. Only the dev Nitro plugin imports the history code, so a build does not include it and never records runs. On a deployment, `runs list`, `runs show`, and `runs clear` fail with `WORKFLOW_RUNS_UNAVAILABLE` (`409`). Read one deployed run with `vitehub workflow get <runId> --workflow <name>`. An id that the history does not have fails with `WORKFLOW_RUN_NOT_FOUND` (`404`).
