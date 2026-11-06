---
title: Run the Codex SDK in production with ViteHub
description: Run OpenAI Codex as a ViteHub Agent. Define it in one file with codexDriver(), call it from a route or a Channel, inspect each run, and deploy it to a Node.js host.
navigation.title: Codex SDK
navigation.order: 5
navigation.group: Agents
icon: i-simple-icons-openai
---

To run Codex in production with ViteHub, install `@openai/codex`, set `driver: codexDriver()` in an Agent Definition file, and deploy the app to a Node.js host. Codex runs its own agent loop, shell tools, approvals, and threads. ViteHub adds what the Codex SDK leaves to you: one Definition file, Channels such as GitHub and Slack, a Workspace or a Sandbox for each run, Capability tools, a bounded Codex Home, and Invocation records that you can read with the CLI and the Console.

## What the Codex SDK is

The [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) (`@openai/codex-sdk`) is OpenAI's TypeScript library to start, continue, and resume local Codex threads from your own code. For deeper integrations, OpenAI documents the [Codex app server](https://learn.chatgpt.com/docs/app-server), a JSON-RPC interface for authentication, conversation history, approvals, and streamed agent events.

ViteHub does not use `@openai/codex-sdk`. `codexDriver()` starts the Codex CLI from `@openai/codex` and talks to its app server through T3 Code's provider runtime. You get the same Codex agent, and you do not write the process, thread, and event code yourself. ViteHub converts Codex text, reasoning, tool calls, approvals, usage, and errors into Agent Invocation events.

## Set up Codex

These steps start from the Vite app of [Installation](/docs/getting-started/installation). You need Node.js 22.22 or newer on Linux or macOS, pnpm, and an OpenAI API key or a ChatGPT plan.

### Install the packages

```bash [Terminal]
pnpm add @vite-hub/agent @openai/codex@0.149.1
```

`@openai/codex` installs one native Codex package for your OS and CPU. If `@openai/codex` is not installed, ViteHub uses `codex` from the host `PATH`. It does not download provider packages during the build or at startup.

### Enable Agents on the Node preset

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    preset: 'node',
    agent: true,
    workflow: false,
  })],
})
```

`workflow: false` is correct here because the Agent finishes inside the HTTP request. Codex starts as a local process, so the Agent needs a Node.js host. See [Where Codex can run](#where-codex-can-run).

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

ViteHub discovers the Agent name `reviewer` from the file path. `runtime: false` runs the Agent inline, so a route can wait for the result.

| Option | What it does |
| --- | --- |
| `gateway` | Sends the Codex model requests through an [AI gateway](/docs/agents/ai-gateways). `openai()` calls the OpenAI API with your key. |
| `model` | A model ID that Codex and the gateway accept. |
| `reasoningEffort` | A reasoning effort that the model supports, such as `'low'`, `'high'`, or `'xhigh'`. Requires `model`. `reasoningSummary` takes `'auto'`, `'concise'`, `'detailed'`, or `'none'`. |
| `instructions` | Instructions for this Agent. ViteHub writes them as Codex instructions. |
| `permissions` | `'ask'` (the default), `'allow-edits'`, `'allow-edits-unattended'`, or `'allow-all'`. `'allow-edits-unattended'` lets Codex edit files and denies other permission requests without a prompt. |
| `requirements` | Commands that Codex needs. `agent.status()` reports the commands that are missing on the host. |

[Agent Drivers](/docs/agents/agent-drivers#use-a-provider-backed-driver) lists every option, such as `env`, `launch`, `cwd`, `toolchain`, `retention`, `sessionStorePath`, `output`, and `capacity`.

### Set the credential

```sh [.env]
OPENAI_API_KEY=sk-...
```

`openai()` reads `VITEHUB_OPENAI_API_KEY` first, then `OPENAI_API_KEY`. ViteHub declares the value in Server Env as `env.server.openai.apiKey`, so an [Env provider](/docs/env/server-api#read-external-env-storage) can supply it and the Console shows that it is declared. ViteHub gives Codex a generated `vitehub` model provider with `-c` overrides. The key goes in the provider environment as `VITEHUB_GATEWAY_API_KEY`, and the launch arguments contain only the variable name.

ViteHub does not forward other process variables to Codex. An `OPENAI_API_KEY` in the server environment reaches Codex only through the gateway or `driver.env`.

Codex can also sign in in other ways:

| Credential | Set |
| --- | --- |
| A ChatGPT Plus or Pro plan | `gateway: chatgpt()` from `vite-hub/gateways` and a [ChatGPT Connection](/docs/connections/chatgpt). OpenAI allows plan use only for some kinds of apps; read that page first. |
| A Codex `auth.json` | `credentials` with the file contents or a sealed Server Env value, and `credentialProfile` to keep one writable Codex Home. Provisioned credentials need a POSIX host. |
| Another gateway | `vercel()`, `openrouter()`, `litellm()`, `cliproxy()`, `ollama()`, or `defineAiGateway()`. See [AI gateway presets](/docs/agents/ai-gateways#presets). |

Without a gateway or `credentials`, Codex uses the Codex Home of the host user. A gateway replaces `credentials` and `credentialProfile`.

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

  const [error, text] = await runAgent(reviewer, { prompt: body.prompt }, { output: 'drained' })
  if (error) throw error
  return { text }
})
```

`{ output: 'drained' }` waits for the run to end and returns `[error, text]`. Read [Invocations](/docs/agents/invocations) to stream the events instead.

This route has no sign-in. Each request starts Codex on your server and uses your API key. Add [Auth](/docs/auth) before you deploy it.

Start the app and send a prompt:

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/review \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create hello.txt with the text hi, then list the files."}'
```

Each Invocation runs in a new temporary directory, and ViteHub removes it when the run ends. To give Codex files and keep its changes, add a [Workspace](/docs/agents/workspace-context). To use a directory that your app prepares, such as a pull request checkout, set `cwd`.

### Talk to the Agent from the CLI

While the dev server runs, inspect the resolved Definition and send a prompt from another terminal:

```bash [Terminal]
pnpm vitehub agent info --agent reviewer --url http://localhost:3000
pnpm vitehub agent dev --agent reviewer --url http://localhost:3000 -p "Which tools can you use?"
```

`agent info` shows the Driver, the gateway name, its execution authority, tools, and instructions. It does not run Codex. See [Talk to an Agent during development](/docs/development/cli#talk-to-an-agent-during-development).

### Connect a Channel

A Channel starts an Invocation from a message, for example a GitHub pull request comment or a Slack mention. Add it to the same Definition:

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

Each Channel needs its own provider credentials and webhook. [Agent Channels](/docs/agents/channels) lists the helpers and their setup.

## Deploy Codex

Build on the same OS, CPU, and Linux libc as the deployment host. The build copies only the native Codex package of the build host into `.output/server/node_modules`.

```bash [Terminal]
pnpm build
OPENAI_API_KEY=sk-... PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` directory to the server, a container, or a virtual machine. [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) explains `dataDir` and storage that survives a restart.

For a long-lived server:

- Codex keeps every session in its Home and does not remove them. Set `retention`, for example `{ maxAge: '14d', maxSize: '45%' }`, to keep a persistent Home bounded. See [Limit the Codex Home size](/docs/agents/agent-drivers#limit-the-codex-home-size).
- Set `sessionStorePath` to keep Codex thread cursors in a SQLite file, so a thread continues after a restart. With `credentials`, this needs a `credentialProfile`.
- Share one `capacity` object across Agents to limit how many Codex processes run at the same time. See [Adaptive process capacity](/docs/agents/agent-drivers#adaptive-process-capacity).
- Use a [process host](/docs/agents/process-hosts) for background work that must recover and drain on restart.

## Inspect each run

Every run is an Agent Invocation. Read it from code, the CLI, or the Console:

- `agent.status()` checks that Codex is installed and signed in, and reads its quota when Codex reports one. It sends no prompt. See [Provider status](/docs/agents/provider-status).
- `vitehub agent invocations list` and `vitehub agent invocations tail <id>` read the Invocation journal, also on a deployed Console with `--url`. See [the CLI reference](/docs/development/cli#inspect-and-cancel-on-a-deployed-app).
- `vitehub agent codex-home status --home <path>` reports the size of a Codex Home without the app.
- The [Console](/docs/development/console) shows the trace, tool calls, and usage of each Invocation.

## Where Codex can run

`codexDriver()` starts Codex as a child process. Only hosts that let the server start a process can run it.

| Host | Support |
| --- | --- |
| Self-hosted Node.js on Linux or macOS, arm64 or x64 | Supported. Use `preset: 'node'`. |
| `vite dev` on Linux or macOS | Supported. |
| Cloudflare Workers | Not supported. A Worker build that contains a provider Driver fails with `AGENT_B0019`. In development, the Invocation fails with `AGENT_R0928`. |
| Deno | Not supported. |
| Vercel Functions | Not tested. The build copies the provider packages of the build host into the server function, but ViteHub has no live run of a provider Driver on Vercel. |
| Windows | Provider Workspaces and provisioned `credentials` do not work. Self-hosted builds package Codex for macOS and Linux only. |

To run Codex on another machine or with a private Home, set `sandbox` on the Agent. ViteHub documents two Sandbox runtimes for provider Drivers: `trusted-host` and `crabbox`. Capability tools reach Codex through a loopback server, so they work only on `trusted-host`, or on `crabbox` with `network: 'direct'`. With `sandbox`, put the credentials in the Sandbox, for example a seeded `.codex/auth.json`, not in the Driver. `chatgpt()` does not work with `sandbox`. `trusted-host` does not isolate the filesystem, the network, or processes. Read [Run a provider Driver in a Sandbox](/docs/agents/agent-drivers#run-a-provider-driver-in-a-sandbox) and [Sandboxes](/docs/agents/sandboxes).

An app that must run on Cloudflare Workers can use a model-backed Driver instead, also with the ChatGPT plan: `driver: { model: 'gpt-5.5', gateway: chatgpt() }`. It runs the ViteHub tool loop, not Codex.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers): every provider Driver option.
- [AI gateways](/docs/agents/ai-gateways): presets, variables, and custom gateways.
- [ChatGPT Connection](/docs/connections/chatgpt): run Codex on a ChatGPT plan.
- [Run the Claude Agent SDK with ViteHub](/docs/guides/claude-agent-sdk): the same setup with Claude Code.
- [Sandboxes](/docs/agents/sandboxes) and [Compare AI sandbox providers](/docs/guides/sandbox-providers).
- [Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel): deploy a model-backed Agent to serverless hosts.
- [Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
