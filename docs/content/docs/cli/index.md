---
title: ViteHub CLI
description: Run package-owned development workflows through the local Vite config with the vitehub command.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
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
- `blob`, `database`, `env`, `kv`, `rate-limit`, `schedule`, `workflow`, and `workspace`, each when its plugin is active (`hubBlob()`, `hubDb()`, `hubEnv()`, `hubKv()`, `hubRateLimit()`, `hubSchedule()`, `hubWorkflow()`, `hubWorkspace()`).
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
  types       Generate ViteHub TypeScript declarations.
  i18n        Show translation coverage, and move translations to and from PO files.
  decisions   List the Decisions of the app and run one with a text. Does not load the project config.
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
| `vitehub content schedule` | Available | Content Package | Publish the listed draft documents at a later time, pinned to their digests. |
| `vitehub content scheduled` | Available | Content Package | List pending, overdue, and failed schedules. |
| `vitehub content unschedule` | Available | Content Package | Cancel a pending schedule, or dismiss a failed one. |
| `vitehub content sitemap` | Available | Content Package | Print the sitemap URLs of published documents. |
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
| `vitehub database tables` | Available | ViteHub Framework | List the tables of a database with their columns and relationships, from the running app or a deployment. |
| `vitehub database rows` | Available | ViteHub Framework | Read one page of rows of a table, sorted or searched, from the running app or a deployment. |
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

## Next steps

- Use [Project commands](/docs/cli/project) to create, link, and deploy an app.
- Use [Server Primitive commands](/docs/cli/primitives) to read and write the data of a running app.
- Use [Agent commands](/docs/cli/agents) to talk to an Agent and run Agent Evals.
- Use [Inspect, operate, and provision](/docs/cli/inspect) to see what ViteHub discovered and to call any operation.
- Use [CLI troubleshooting](/docs/cli/troubleshooting) when a command fails.
- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.
