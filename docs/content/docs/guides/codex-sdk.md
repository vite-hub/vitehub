---
title: Run the Codex SDK in production with ViteHub
description: "Run OpenAI Codex as a ViteHub Agent. Define it with codexDriver(), call it from a route or a Channel, inspect each run, and deploy it to a Node.js host."
navigation.title: Codex SDK
navigation.order: 5
navigation.group: Agents
icon: i-simple-icons-openai
---

Install `@openai/codex`, set `driver: codexDriver()` in an Agent Definition file, and deploy to a Node.js host. Codex runs its own agent loop, shell tools, approvals, and threads. ViteHub adds Channels (GitHub, Slack), a Workspace or Sandbox per run, Capability tools, a size-limited Codex Home, and run records (Invocations).

## What the Codex SDK is

The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (`@openai/codex-sdk`) is OpenAI's TypeScript library to start, continue, and resume local Codex threads. The [Codex app server](https://learn.chatgpt.com/docs/app-server) is a JSON-RPC interface for deeper integrations: auth, history, approvals, and streamed events.

ViteHub does not use `@openai/codex-sdk`. `codexDriver()` starts the Codex CLI from `@openai/codex` and talks to its app server through T3 Code's provider runtime, so you write no process, thread, or event code. ViteHub turns Codex text, reasoning, tool calls, approvals, usage, and errors into Invocation events.

## Set up Codex

Start from the app of [Installation](/docs/getting-started/installation). You need Node.js 22.22 or newer on Linux or macOS, pnpm, and an OpenAI API key or a ChatGPT plan.

### Install the packages

```bash [Terminal]
pnpm add @vite-hub/agent @openai/codex@0.149.1
```

`@openai/codex` installs one native Codex package for your OS and CPU. Without it, ViteHub uses `codex` from the host `PATH`. ViteHub downloads nothing during the build or at startup.

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

`workflow: false` fits because the Agent finishes inside the HTTP request. Codex starts as a local process, so it needs a Node.js host. See [Where Codex can run](#where-codex-can-run).

### Define the Agent

```ts [server/agents/reviewer.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { openai } from 'vite-hub/gateways'

export default defineAgent({
  runtime: false,
  driver: codexDriver({
    // Reads OPENAI_API_KEY.
    gateway: openai(),
    model: 'gpt-5.5',
    reasoningEffort: 'high',
    instructions: 'Answer with the commands that you ran and their result.',
    permissions: 'allow-edits-unattended',
    requirements: ['git'],
  }),
})
```

The Agent name `reviewer` comes from the file path. `runtime: false` runs the Agent inline, so a route can wait for the result.

| Option | What it does |
| --- | --- |
| `gateway` | Sends model requests through an [AI gateway](/docs/gateways). `openai()` calls the OpenAI API with your key. |
| `model` | A model ID that Codex and the gateway accept. |
| `reasoningEffort` | A reasoning effort the model supports, such as `'low'`, `'high'`, or `'xhigh'`. Needs `model`. `reasoningSummary` takes `'auto'`, `'concise'`, `'detailed'`, or `'none'`. |
| `instructions` | Instructions for this Agent, passed as Codex instructions. |
| `permissions` | `'ask'` (default), `'allow-edits'`, `'allow-edits-unattended'`, or `'allow-all'`. `'allow-edits-unattended'` allows file edits and denies other requests without a prompt. |
| `requirements` | Commands Codex needs. `agent.status()` reports the ones missing on the host. |

[Agent Drivers](/docs/agents/agent-drivers#use-a-provider-backed-driver) lists all options, such as `env`, `launch`, `cwd`, `toolchain`, `sessionStorePath`, `output`, and `capacity`.

### Set the credential

```sh [.env]
OPENAI_API_KEY=sk-...
```

`openai()` reads `VITEHUB_OPENAI_API_KEY` first, then `OPENAI_API_KEY`. It is declared in Server Env as `env.server.openai.apiKey`, so an [Env provider](/docs/env/server-api#read-external-env-storage) can supply it and the Console shows it. Codex gets a generated `vitehub` model provider through `-c` overrides, with the key in `VITEHUB_GATEWAY_API_KEY`. The launch arguments hold only the variable name.

ViteHub forwards no other process variables, so a server `OPENAI_API_KEY` reaches Codex only through the gateway or `driver.env`. Other ways to sign in:

| Credential | Set |
| --- | --- |
| A ChatGPT Plus or Pro plan | `gateway: chatgpt()` from `vite-hub/gateways` and a [ChatGPT Connection](/docs/connections/chatgpt). OpenAI allows plan use only for some kinds of apps, so read that page first. |
| A Codex `auth.json` | `credentials` with the file contents or a sealed Server Env value, and `credentialProfile` to keep one writable Codex Home. Needs a POSIX host. |
| Another gateway | `vercel()`, `openrouter()`, `litellm()`, `cliproxy()`, `ollama()`, or `defineAiGateway()`. See [AI gateway presets](/docs/gateways/configure#presets). |

With neither a gateway nor `credentials`, Codex uses the host user's Codex Home. A gateway replaces `credentials` and `credentialProfile`.

### Call the Agent from a route

```ts [server/api/review.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import reviewer from '../agents/reviewer'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt?: unknown }>(event)
  if (typeof body?.prompt !== 'string' || !body.prompt.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty prompt.' })
  }

  const [error, result] = await runAgent(reviewer, { prompt: body.prompt })
  if (error) throw error
  return { text: result.text }
})
```

`runAgent()` waits for the run to end and returns `[error, result]`. Read [Invocations](/docs/agents/invocations) to stream the events instead.

::warning
This route has no sign-in. Each request starts Codex on your server with your API key. Add [Auth](/docs/auth) before you deploy it.
::

Start the app and send a prompt:

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/review \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create hello.txt with the text hi, then list the files."}'
```

Each Invocation runs in a new temporary folder, deleted at the end. To give Codex files and keep its changes, add a [Workspace](/docs/agents/workspace-context), or set `cwd` to a folder your app prepares, such as a pull request checkout.

### Talk to the Agent from the CLI

While the dev server runs, inspect the Definition and send a prompt from another terminal:

```bash [Terminal]
pnpm vitehub agent info --agent reviewer --url http://localhost:3000
pnpm vitehub agent dev --agent reviewer --url http://localhost:3000 -p "Which tools can you use?"
```

`agent info` shows the Driver, gateway name, execution authority, tools, and instructions, without running Codex. See [Talk to an Agent during development](/docs/cli/agents#talk-to-an-agent-during-development).

### Connect a Channel

A Channel starts an Invocation from a message, such as a GitHub pull request comment or a Slack mention. Add it to the same Definition:

```ts [server/agents/reviewer.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'
import { github } from 'vite-hub/agent/channels'
import { openai } from 'vite-hub/gateways'

export default defineAgent({
  runtime: false,
  channels: {
    github: github({ pullRequest: true }),
  },
  driver: codexDriver({
    gateway: openai(),
    model: 'gpt-5.5',
    permissions: 'allow-edits-unattended',
  }),
})
```

Each Channel needs its own credentials and webhook. See [Agent Channels](/docs/agents/channels).

## Deploy Codex

Build on the same OS, CPU, and Linux libc as the server. The build copies only the build machine's native Codex package into `.output/server/node_modules`.

```bash [Terminal]
pnpm build
OPENAI_API_KEY=sk-... PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` folder to the server, container, or VM. [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) explains `dataDir` and storage that survives a restart.

For a long-lived server:

- Set `sessionStorePath` to keep thread cursors in a SQLite file, so a thread continues after a restart. With `credentials`, this needs a `credentialProfile`.
- Share one `capacity` object across Agents to cap concurrent Codex processes. See [Adaptive process capacity](/docs/agents/agent-drivers#adaptive-process-capacity).
- Use a [process host](/docs/agents/process-hosts) for background work that must recover and drain on restart.

## Inspect each run

Every run is an Invocation. Read it from code, the CLI, or the Console:

- `agent.status()` checks that Codex is installed and signed in, and reads its quota if reported. It sends no prompt. See [Provider status](/docs/agents/provider-status).
- `vitehub agent invocations list` and `vitehub agent invocations tail <id>` read the Invocation log, also on a deployed app with `--url`. See [the CLI reference](/docs/cli/agents#inspect-and-cancel-on-a-deployed-app).
- The [Console](/docs/console) shows the trace, tool calls, and usage of each Invocation.

## Where Codex can run

`codexDriver()` starts Codex as a child process, so the host must allow that.

| Host | Support |
| --- | --- |
| Self-hosted Node.js on Linux or macOS, arm64 or x64 | Supported. Use `host: 'node'`. |
| `vite dev` on Linux or macOS | Supported. |
| Cloudflare Workers | Not supported. A Worker build with a provider Driver fails with `AGENT_B0019`. In dev, the Invocation fails with `AGENT_R0928`. |
| Deno | Not supported. |
| Vercel Functions | Not tested. The build copies the build machine's provider packages into the function, but we have not run a provider Driver live on Vercel. |
| Windows | Provider Workspaces and provisioned `credentials` do not work. Self-hosted builds package Codex for macOS and Linux only. |

To run Codex on another machine or with a private Home, set `sandbox` on the Agent. Provider Drivers support two Sandbox runtimes: `trusted-host` and `crabbox`. Capability tools reach Codex through a loopback server, so they work only on `trusted-host`, or on `crabbox` with `network: 'direct'`. With `sandbox`, put the credentials in the Sandbox, such as a seeded `.codex/auth.json`, not the Driver. `chatgpt()` does not work with `sandbox`.

::warning
`trusted-host` does not isolate the filesystem, the network, or processes.
::

See [Run a provider Driver in a Sandbox](/docs/agents/agent-drivers#run-a-provider-driver-in-a-sandbox) and [Sandboxes](/docs/agents/sandboxes).

On Cloudflare Workers, use a model-backed Driver instead, also with the ChatGPT plan: `driver: { model: 'gpt-5.5', gateway: chatgpt() }`. It runs the ViteHub tool loop, not Codex.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers): all provider Driver options.
- [AI gateways](/docs/gateways): presets, variables, and custom gateways.
- [ChatGPT Connection](/docs/connections/chatgpt): run Codex on a ChatGPT plan.
- [Run the Claude Agent SDK with ViteHub](/docs/guides/claude-agent-sdk): the same setup for Claude Code.
- [Sandboxes](/docs/agents/sandboxes) and [Compare AI sandbox providers](/docs/guides/sandbox-providers).
- [Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel): a model-backed Agent on serverless hosts.
- [Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
