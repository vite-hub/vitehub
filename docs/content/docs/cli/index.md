---
title: ViteHub CLI
description: Run the workflows of every ViteHub package from your terminal, CI, or an Agent with one vitehub command that reads your Vite config.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-terminal-square
---

The `vitehub` command is where you deploy the app, read its KV keys, run a task, or talk to an Agent. It loads your Vite config and picks up the commands that each active ViteHub package adds, so every command comes from the package that knows the work.

## Install and open help

The [`vite-hub` npm package](https://www.npmjs.com/package/vite-hub) ships the `vitehub` binary.

```bash [Terminal]
pnpm add vite-hub
pnpm vitehub --help
```

Help lists the **namespaces**, the command groups, of the packages your app turns on. A package that is not set up adds no commands.

| Namespace | Shows when |
| --- | --- |
| `agent`, `channels`, `conversations` | `hubAgent()` is active. |
| `blob`, `database`, `env`, `kv`, `rate-limit`, `schedule`, `workflow`, `workspace` | Its plugin is active: `hubBlob()`, `hubDatabase()`, `hubEnv()`, `hubKV()`, `hubRateLimit()`, `hubSchedule()`, `hubWorkflow()`, or `hubWorkspace()`. |
| `content` | The app defines `server/content.ts`. |
| `console` | `console` is on. |
| `types`, `task`, `decisions`, `sandbox` | Always. The framework adds them. |
| `inspect`, `provision` | Always. They are built into the CLI, and a plugin command named `inspect` is ignored. |

::note
`decisions` and `sandbox` do not load the project config, and `sandbox` also runs in a deployed container without Vite. `@vite-hub/cli` is the runner behind the `vitehub` binary and has no binary of its own.
::

The [command reference](/docs/cli/reference) has the full help output and every command with its owner package.

## Find a command

| Page | Commands |
| --- | --- |
| [Project](/docs/cli/project) | `init`, `catalog`, `status`, `add`, `remove`, and the dev Setup endpoints. |
| [Link and deploy](/docs/cli/deploy) | `link`, `unlink`, `deploy`, `deployments`. |
| [Blob, KV, Rate Limit](/docs/cli/storage) | `blob`, `kv`, `rate-limit`. |
| [Database](/docs/cli/database) | `database generate`, `migrate`, `up`, `export`, `seed`, `tables`, `rows`. |
| [Content and Workspace](/docs/cli/content) | `content`, `i18n`, `workspace`, `pull`, `push`, `hooks`, `resolve`. |
| [Tasks, Schedules, Workflows](/docs/cli/jobs) | `task`, `schedule`, `workflow`. |
| [Env and Email](/docs/cli/env) | `env`, `secret`, `email`. |
| [Decisions](/docs/cli/decisions) | `decisions list`, `decisions run`. |
| [Agents](/docs/cli/agents) | `agent eval`, `agent info`, `agent invocations`, `agent dev`. |
| [Channels](/docs/cli/channels) | `channels`, `conversations`. |
| [Operations](/docs/cli/operations) | Every package operation as a command, and `--url` for a deployed app. |
| [Inspect and provision](/docs/cli/inspect) | `inspect`, `provision`. |
| [Troubleshooting](/docs/cli/troubleshooting) | Common failures, and the [CLI diagnostics](/docs/cli/diagnostics) for each error code. |

## Next steps

- [Agent Evals](/docs/agents/evals) check what an Agent does.
- [Workspace](/docs/workspace) covers Workspace Sessions and write access.
- [Provisioning](/docs/development/provisioning) explains provider resource ids.
- [Config options](/docs/reference/config-options) lists the package integration switches.
