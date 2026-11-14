---
title: ViteHub CLI
description: Run package-owned development workflows through the local Vite config with the vitehub command, from your terminal, CI, or an Agent.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-terminal-square
---

The `vitehub` CLI is one entry point for developers and agents. It loads your Vite config and collects the commands each ViteHub package adds, so each command stays with the package that knows the workflow. Each run reads each active plugin's commands and Provision Steps once. The [`vite-hub` npm package](https://www.npmjs.com/package/vite-hub) ships one binary, `vitehub`.

The CLI loads your Vite config without the development invocation route, but with Console routes. `vite dev` keeps its development invocation endpoint inside the reserved `/_vitehub/agent` namespace. An app fallback may contain it, but exact, parameterized, and wildcard routes still conflict. Your own routes keep strict conflict checks. The first SSR import can load the generated Agent registry before server internals finish starting. Registry refreshes still reset found public URL names.

## Install and open help

The `vite-hub` package includes the CLI. Commands come from active Vite plugins, so a package that is not set up has no commands.

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

The [command reference](/docs/cli/reference) shows the full help output and every command with its owner package.

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

- Use [Agent Evals](/docs/agents/evals) for behaviour checks.
- Use [Workspace](/docs/workspace) for Workspace Sessions and write access.
- Use [Provisioning](/docs/development/provisioning) for provider resource ids.
- Use [Config options](/docs/reference/config-options) for package integration switches.
