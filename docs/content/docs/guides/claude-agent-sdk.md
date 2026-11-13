---
title: Run the Claude Agent SDK in production with ViteHub
description: "Run the Claude Agent SDK as a ViteHub Agent. Define it with claudeCodeDriver(), call it from a route or a Channel, inspect each run, and deploy it to Node.js."
navigation.title: Claude Agent SDK
navigation.order: 4
navigation.group: Agents
icon: i-simple-icons-anthropic
---

Install `@anthropic-ai/claude-agent-sdk`, set `driver: claudeCodeDriver()` in an Agent Definition file, and deploy to a Node.js host. Claude Code runs its own agent loop, tools, and sessions. ViteHub adds Channels (GitHub, Slack), a Workspace or Sandbox per run, Capability tools, approvals, and run records (Invocations).

## What the Claude Agent SDK is

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is Anthropic's library to run Claude Code in your own app, with the same tools, agent loop, permissions, and sessions. It was called the Claude Code SDK (see the [migration guide](https://code.claude.com/docs/en/agent-sdk/migration-guide)).

The SDK runs the Claude Code binary as a local process. A ViteHub Agent with `claudeCodeDriver()` is the server around it: it starts the process, gives it a folder and credentials, connects users, and records the run. ViteHub runs the SDK through T3 Code's provider runtime and turns its text, tool calls, approvals, usage, and errors into Invocation events.

## Set up the Claude Agent SDK

Start from the app of [Installation](/docs/getting-started/installation). You need Node.js 22.22 or newer on Linux or macOS, pnpm, and an Anthropic API key (see the [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)).

### Install the packages

```bash [Terminal]
pnpm add @vite-hub/agent @anthropic-ai/claude-agent-sdk@0.3.321
```

The SDK installs one native Claude Code package for your OS and CPU. ViteHub uses that package and downloads nothing during the build or at startup.

### Enable Agents on the Node host

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    agent: true,
    workflow: false,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    agent: true,
    workflow: false,
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    agent: true,
    workflow: false,
  })],
})
```
:::
::

`workflow: false` fits because the Agent finishes inside the HTTP request. A provider Driver starts a local process, so it needs a Node.js host. See [Where the Claude Agent SDK can run](#where-the-claude-agent-sdk-can-run).

### Define the Agent

```ts [server/agents/coder.ts]
import { claudeCodeDriver, defineAgent } from 'vite-hub/agent'
import { anthropic } from 'vite-hub/gateways'

export default defineAgent({
  runtime: false,
  driver: claudeCodeDriver({
    // Reads ANTHROPIC_API_KEY.
    gateway: anthropic(),
    instructions: 'Answer with the commands that you ran and their result.',
    permissions: 'allow-edits-unattended',
    requirements: ['git'],
  }),
})
```

The Agent name `coder` comes from the file path. `runtime: false` runs the Agent inline, so a route can wait for the result.

| Option | What it does |
| --- | --- |
| `gateway` | Sends model requests through an [AI gateway](/docs/gateways). `anthropic()` calls the Anthropic API with your key. |
| `instructions` | Instructions for this Agent, written to a prompt file for Claude Code. |
| `permissions` | `'ask'` (default), `'allow-edits'`, `'allow-edits-unattended'`, or `'allow-all'`. `'allow-edits-unattended'` allows file edits and denies other requests without a prompt. |
| `requirements` | Commands Claude Code needs. `agent.status()` reports the ones missing on the host. |
| `model` | Optional. A model ID that Claude Code and the gateway accept. |

[Agent Drivers](/docs/agents/agent-drivers#use-a-provider-backed-driver) lists all options, such as `env`, `launch`, `cwd`, `toolchain`, `sessionStorePath`, `output`, and `capacity`.

### Set the credential

```sh [.env]
ANTHROPIC_API_KEY=sk-ant-...
```

`anthropic()` reads `VITEHUB_ANTHROPIC_API_KEY` first, then `ANTHROPIC_API_KEY`. ViteHub declares it in Server Env as `env.server.anthropic.apiKey`, so an [Env provider](/docs/env/server-api#read-external-env-storage) can supply it and the Console shows it. Claude Code gets the key in `ANTHROPIC_API_KEY`, plus `ANTHROPIC_BASE_URL`.

ViteHub forwards no other process variables, so a server `ANTHROPIC_API_KEY` reaches Claude Code only through the gateway or `driver.env`. With no gateway, Claude Code uses the host user's sign-in. Use an API key for an app that other people use: Anthropic does not allow third-party products to offer claude.ai sign-in (see the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).

To use another service, change the preset: `vercel()`, `openrouter()`, `litellm()`, `cliproxy()`, and `ollama()` also serve Claude Code. [AI gateway presets](/docs/gateways/configure#presets) lists their variables.

### Call the Agent from a route

```ts [server/api/code.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import coder from '../agents/coder'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt?: unknown }>(event)
  if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty prompt.' })
  }

  const [error, result] = await runAgent(coder, { prompt: body.prompt })
  if (error) throw error
  return { text: result.text }
})
```

`runAgent()` waits for the run to end and returns `[error, result]`. Read [Invocations](/docs/agents/invocations) to stream the events instead.

::warning
This route has no sign-in. Each request starts Claude Code on your server with your API key. Add [Auth](/docs/auth) before you deploy it.
::

Start the app and send a prompt:

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/code \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create hello.txt with the text hi, then list the files."}'
```

Each Invocation runs in a new temporary folder, deleted at the end. To give Claude Code files and keep its changes, add a [Workspace](/docs/agents/workspace-context), or set `cwd` to a folder your app prepares.

### Talk to the Agent from the CLI

While the dev server runs, inspect the Definition and send a prompt from another terminal:

```bash [Terminal]
pnpm vitehub agent info --agent coder --url http://localhost:3000
pnpm vitehub agent dev --agent coder --url http://localhost:3000 -p "Which tools can you use?"
```

`agent info` shows the Driver, its execution authority, tools, and instructions, without running Claude Code. See [Talk to an Agent during development](/docs/development/cli#talk-to-an-agent-during-development).

### Connect a Channel

A Channel starts an Invocation from a message, such as a GitHub pull request comment or a Slack mention. Add it to the same Definition:

```ts [server/agents/coder.ts]
import { claudeCodeDriver, defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'
import { anthropic } from 'vite-hub/gateways'

export default defineAgent({
  runtime: false,
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: claudeCodeDriver({
    gateway: anthropic(),
    permissions: 'allow-edits-unattended',
  }),
})
```

Each Channel needs its own credentials and webhook. See [Agent Channels](/docs/agents/channels).

## Deploy the Claude Agent SDK

Build on the same OS, CPU, and Linux libc as the server. The build copies only the build machine's native Claude Code package into `.output/server/node_modules`.

```bash [Terminal]
pnpm build
ANTHROPIC_API_KEY=sk-ant-... PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` folder to the server, container, or VM. [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) explains `dataDir` and storage that survives a restart.

For a long-lived server:

- Set `sessionStorePath` to keep session cursors in a SQLite file, so a thread continues after a restart.
- Share one `capacity` object across Agents to cap concurrent Claude Code processes. See [Adaptive process capacity](/docs/agents/agent-drivers#adaptive-process-capacity).
- Use a [process host](/docs/agents/process-hosts) for background work that must recover and drain on restart.

## Inspect each run

Every run is an Invocation. Read it from code, the CLI, or the Console:

- `agent.status()` checks that Claude Code is installed and signed in, and reads its quota if reported. It sends no prompt. See [Provider status](/docs/agents/provider-status).
- `vitehub agent invocations list` and `vitehub agent invocations tail <id>` read the Invocation log, also on a deployed app with `--url`. See [the CLI reference](/docs/development/cli#inspect-and-cancel-on-a-deployed-app).
- The [Console](/docs/development/console) shows the trace, tool calls, and usage of each Invocation.

## Where the Claude Agent SDK can run

`claudeCodeDriver()` starts Claude Code as a child process, so the host must allow that.

| Host | Support |
| --- | --- |
| Self-hosted Node.js on Linux or macOS, arm64 or x64 | Supported. Use `host: 'node'`. |
| `vite dev` on Linux or macOS | Supported. |
| Cloudflare Workers | Not supported. A Worker build with a provider Driver fails with `AGENT_B0019`. In dev, the Invocation fails with `AGENT_R0928`. |
| Deno | Not supported. |
| Vercel Functions | Not tested. The build copies the build machine's provider packages into the function, but we have not run a provider Driver live on Vercel. |
| Windows | Provider Workspaces do not work. Self-hosted builds package Claude Code for macOS and Linux only. |

To run Claude Code on another machine or with a private Home, set `sandbox` on the Agent. Provider Drivers support two Sandbox runtimes: `trusted-host` and `crabbox`. Capability tools reach Claude Code through a loopback server, so they work only on `trusted-host`, or on `crabbox` with `network: 'direct'`. With `sandbox`, put the credentials in the Sandbox, not the Driver.

::warning
`trusted-host` does not isolate the filesystem, the network, or processes.
::

See [Run a provider Driver in a Sandbox](/docs/agents/agent-drivers#run-a-provider-driver-in-a-sandbox) and [Sandboxes](/docs/agents/sandboxes).

On Cloudflare Workers, use a model-backed Driver with an Anthropic model instead. It runs the ViteHub tool loop, not Claude Code.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers): all provider Driver options.
- [AI gateways](/docs/gateways): presets, variables, and custom gateways.
- [Run the Codex SDK with ViteHub](/docs/guides/codex-sdk): the same setup for OpenAI Codex.
- [Sandboxes](/docs/agents/sandboxes) and [Compare AI sandbox providers](/docs/guides/sandbox-providers).
- [Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel): a model-backed Agent on serverless hosts.
- [Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
