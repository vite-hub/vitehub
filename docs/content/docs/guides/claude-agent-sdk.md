---
title: Run the Claude Agent SDK in production with ViteHub
description: Run the Claude Agent SDK as a ViteHub Agent. Define it in one file with claudeCodeDriver(), call it from a route or a Channel, inspect each run, and deploy it to a Node.js host.
navigation.title: Claude Agent SDK
navigation.order: 4
navigation.group: Agents
icon: i-simple-icons-anthropic
---

To run the Claude Agent SDK in production with ViteHub, install `@anthropic-ai/claude-agent-sdk`, set `driver: claudeCodeDriver()` in an Agent Definition file, and deploy the app to a Node.js host. Claude Code runs its own agent loop, tools, and sessions. ViteHub adds what the SDK leaves to you: one Definition file, Channels such as GitHub and Slack, a Workspace or a Sandbox for each run, Capability tools, approvals, and Invocation records that you can read with the CLI and the Console.

## What the Claude Agent SDK is

The [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) is Anthropic's library for running Claude Code inside your own application. It gives you the same tools, agent loop, permissions, and sessions that Claude Code uses. Its earlier name was the Claude Code SDK. Anthropic's [migration guide](https://code.claude.com/docs/en/agent-sdk/migration-guide) explains the rename.

The SDK runs the Claude Code binary as a local process. You still need a server that starts that process, gives it a working directory and credentials, connects it to users, and records what it did. A ViteHub Agent with `claudeCodeDriver()` is that server. ViteHub runs the SDK through T3 Code's provider runtime and converts its text, tool calls, approvals, usage, and errors into Agent Invocation events.

## Set up the Claude Agent SDK

These steps start from the Vite app of [Installation](/docs/getting-started/installation). You need Node.js 22.22 or newer on Linux or macOS, pnpm, and an Anthropic API key. Anthropic's [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart) shows how to get one.

### Install the packages

```bash [Terminal]
pnpm add @vite-hub/agent @anthropic-ai/claude-agent-sdk@0.3.246
```

The SDK installs one native Claude Code package for your OS and CPU. ViteHub finds the installed package. It does not download provider packages during the build or at startup.

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

`workflow: false` is correct here because the Agent finishes inside the HTTP request. A provider Driver starts a local process, so it needs a Node.js host. See [Where the Claude Agent SDK can run](#where-the-claude-agent-sdk-can-run).

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

ViteHub discovers the Agent name `coder` from the file path. `runtime: false` runs the Agent inline, so a route can wait for the result.

| Option | What it does |
| --- | --- |
| `gateway` | Sends the Claude Code model requests through an [AI gateway](/docs/agents/ai-gateways). `anthropic()` calls the Anthropic API with your key. |
| `instructions` | Instructions for this Agent. ViteHub writes them to a prompt file for Claude Code. |
| `permissions` | `'ask'` (the default), `'allow-edits'`, `'allow-edits-unattended'`, or `'allow-all'`. `'allow-edits-unattended'` lets Claude Code edit files and denies other permission requests without a prompt. |
| `requirements` | Commands that Claude Code needs. `agent.status()` reports the commands that are missing on the host. |
| `model` | Optional. A model ID that Claude Code and the gateway accept. |

[Agent Drivers](/docs/agents/agent-drivers#use-a-provider-backed-driver) lists every option, such as `env`, `launch`, `cwd`, `toolchain`, `sessionStorePath`, `output`, and `capacity`.

### Set the credential

```sh [.env]
ANTHROPIC_API_KEY=sk-ant-...
```

`anthropic()` reads `VITEHUB_ANTHROPIC_API_KEY` first, then `ANTHROPIC_API_KEY`. ViteHub declares the value in Server Env as `env.server.anthropic.apiKey`, so an [Env provider](/docs/env/server-api#read-external-env-storage) can supply it and the Console shows that it is declared. ViteHub gives the key to Claude Code in `ANTHROPIC_API_KEY` and sets `ANTHROPIC_BASE_URL`.

ViteHub does not forward other process variables to Claude Code. An `ANTHROPIC_API_KEY` in the server environment reaches Claude Code only through the gateway or `driver.env`. Without a gateway, Claude Code uses the sign-in of the host user. Use an API key for an app that other people use. Anthropic does not allow third-party products to offer claude.ai sign-in, see the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview).

To route requests through another service, change the preset. `vercel()`, `openrouter()`, `litellm()`, `cliproxy()`, and `ollama()` also serve Claude Code. See [AI gateway presets](/docs/agents/ai-gateways#presets) for the variables that each one reads.

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

  const [error, text] = await runAgent(coder, { prompt: body.prompt }, { output: 'drained' })
  if (error) throw error
  return { text }
})
```

`{ output: 'drained' }` waits for the run to end and returns `[error, text]`. Read [Invocations](/docs/agents/invocations) to stream the events instead.

This route has no sign-in. Each request starts Claude Code on your server and uses your API key. Add [Auth](/docs/auth) before you deploy it.

Start the app and send a prompt:

```bash [Terminal]
pnpm dev
curl -X POST http://localhost:3000/api/code \
  -H 'content-type: application/json' \
  -d '{"prompt":"Create hello.txt with the text hi, then list the files."}'
```

Each Invocation runs in a new temporary directory, and ViteHub removes it when the run ends. To give Claude Code files and keep its changes, add a [Workspace](/docs/agents/workspace-context). To use a directory that your app prepares, set `cwd`.

### Talk to the Agent from the CLI

While the dev server runs, inspect the resolved Definition and send a prompt from another terminal:

```bash [Terminal]
pnpm vitehub agent info --agent coder --url http://localhost:3000
pnpm vitehub agent dev --agent coder --url http://localhost:3000 -p "Which tools can you use?"
```

`agent info` shows the Driver, its execution authority, tools, and instructions. It does not run Claude Code. See [Talk to an Agent during development](/docs/development/cli#talk-to-an-agent-during-development).

### Connect a Channel

A Channel starts an Invocation from a message, for example a GitHub pull request comment or a Slack mention. Add it to the same Definition:

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

Each Channel needs its own provider credentials and webhook. [Agent Channels](/docs/agents/channels) lists the helpers and their setup.

## Deploy the Claude Agent SDK

Build on the same OS, CPU, and Linux libc as the deployment host. The build copies only the native Claude Code package of the build host into `.output/server/node_modules`.

```bash [Terminal]
pnpm build
ANTHROPIC_API_KEY=sk-ant-... PORT=3000 node .output/server/index.mjs
```

Copy the whole `.output` directory to the server, a container, or a virtual machine. [Node and self-hosted](/docs/frameworks-hosts/node-self-hosted) explains `dataDir` and storage that survives a restart.

For a long-lived server:

- Set `sessionStorePath` to keep Claude Code session cursors in a SQLite file, so a thread continues after a restart.
- Share one `capacity` object across Agents to limit how many Claude Code processes run at the same time. See [Adaptive process capacity](/docs/agents/agent-drivers#adaptive-process-capacity).
- Use a [process host](/docs/agents/process-hosts) for background work that must recover and drain on restart.

## Inspect each run

Every run is an Agent Invocation. Read it from code, the CLI, or the Console:

- `agent.status()` checks that Claude Code is installed and signed in, and reads its quota when Claude Code reports one. It sends no prompt. See [Provider status](/docs/agents/provider-status).
- `vitehub agent invocations list` and `vitehub agent invocations tail <id>` read the Invocation journal, also on a deployed Console with `--url`. See [the CLI reference](/docs/development/cli#inspect-and-cancel-on-a-deployed-app).
- The [Console](/docs/development/console) shows the trace, tool calls, and usage of each Invocation.

## Where the Claude Agent SDK can run

`claudeCodeDriver()` starts Claude Code as a child process. Only hosts that let the server start a process can run it.

| Host | Support |
| --- | --- |
| Self-hosted Node.js on Linux or macOS, arm64 or x64 | Supported. Use `preset: 'node'`. |
| `vite dev` on Linux or macOS | Supported. |
| Cloudflare Workers | Not supported. A Worker build that contains a provider Driver fails with `AGENT_B0019`. In development, the Invocation fails with `AGENT_R0928`. |
| Deno | Not supported. |
| Vercel Functions | Not tested. The build copies the provider packages of the build host into the server function, but ViteHub has no live run of a provider Driver on Vercel. |
| Windows | Provider Workspaces do not work. Self-hosted builds package Claude Code for macOS and Linux only. |

To run Claude Code on another machine or with a private Home, set `sandbox` on the Agent. ViteHub documents two Sandbox runtimes for provider Drivers: `trusted-host` and `crabbox`. Capability tools reach Claude Code through a loopback server, so they work only on `trusted-host`, or on `crabbox` with `network: 'direct'`. With `sandbox`, put the credentials in the Sandbox, not in the Driver. `trusted-host` does not isolate the filesystem, the network, or processes. Read [Run a provider Driver in a Sandbox](/docs/agents/agent-drivers#run-a-provider-driver-in-a-sandbox) and [Sandboxes](/docs/agents/sandboxes).

An app that must run on Cloudflare Workers can use a model-backed Driver with an Anthropic model instead. It runs the ViteHub tool loop, not Claude Code.

## Related pages

- [Agent Drivers](/docs/agents/agent-drivers): every provider Driver option.
- [AI gateways](/docs/agents/ai-gateways): presets, variables, and custom gateways.
- [Run the Codex SDK with ViteHub](/docs/guides/codex-sdk): the same setup with OpenAI Codex.
- [Sandboxes](/docs/agents/sandboxes) and [Compare AI sandbox providers](/docs/guides/sandbox-providers).
- [Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel): deploy a model-backed Agent to serverless hosts.
- [Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks).
