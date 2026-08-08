<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="360">
  </picture>
</p>

<p align="center">
  Portable Agents. Server Primitives for any host.
</p>

<p align="center">
  <a href="https://vitehub.dev">Documentation</a>
  ·
  <a href="https://vitehub.dev/docs/getting-started/installation">Installation</a>
  ·
  <a href="https://vitehub.dev/docs/agents">Agents</a>
  ·
  <a href="https://vitehub.dev/docs/server-primitives">Server primitives</a>
</p>

ViteHub is one platform with two product lanes. ViteHub Agents defines, invokes, and deploys server-side Agents. ViteHub Server Primitives provide ordinary Vite applications with portable state and work across hosts.

## Choose a product lane

### Agents

Agents are named server-side actors. Each Agent Definition picks an Agent Driver, receives Agent Invocations, can read explicit Workspace context, and gains abilities through Capabilities. Start with [your first Agent](https://vitehub.dev/docs/getting-started/first-agent).

### Server Primitives

Server Primitives give app code stable Runtime Helpers for auth, environment values, storage, queues, workflows, schedules, sandboxes, workspace files, and Provider Output. They work without an Agent Definition. Start with [your first Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive).

Agents may compose Server Primitives. Server Primitives never require Agents.

## Installation

Install the framework distribution for the normal application path. It keeps one direct ViteHub dependency while preserving feature boundaries through intentional subpaths.

```bash
pnpm add vite-hub
```

Register the Vite Integration.

```ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vitehub({ preset: "node" }),
  ],
});
```

Model strings use AI Gateway automatically. Set `AI_GATEWAY_API_KEY` in the server environment, or pass an explicit key with `{ id, apiKey }`.

Requirements: Node 24 or newer, Vite 8 or newer, and a server app with `vite.config.ts`.

## First Agent

Create an Agent Definition.

```ts
import { defineAgent } from "vite-hub/agent";

export default defineAgent({
  driver: {
    model: "openai/gpt-5.1-mini",
    instructions: "Answer support questions with short, concrete replies.",
  },
});
```

Run it from server code.

```ts
import { runAgent } from "vite-hub/agent";
import support from "../agents/support";

export default defineEventHandler(async (event) => {
  const body = await readBody<{ prompt: string }>(event);

  return runAgent(support, { runtime: "vite" }, {
    prompt: body.prompt,
  });
});
```

Add Capabilities only when the Agent needs controlled access to tools, storage, Workspace files, chat, product events, or external systems.

## How Agents Work

- An **Agent Definition** declares one Agent and its Agent Driver.
- An **Agent Driver** decides how an Agent Invocation runs: model-backed, harness-backed, or custom-run-backed.
- An **Agent Invocation** is one runtime request to an Agent.
- **Capabilities** attach named abilities. They contribute tools, instructions, triggers, policies, or runtime context.
- A **Workspace** gives an Agent explicit file-tree state. **Sources** place read-only context into that Workspace.
- ViteHub discovers definitions, generates Runtime Registries, and prepares Provider Output through Vite Integrations.

Server code can call primitives directly. Agents do not receive every primitive by default; attach a Capability when the model should use one.

## Server Primitives

Server primitives are useful with or without Agents.

| Need | Start with |
| --- | --- |
| Environment values and secrets | [`vite-hub/env`](https://vitehub.dev/docs/server-primitives/env) |
| Auth and sessions | [`vite-hub/auth`](https://vitehub.dev/docs/server-primitives/auth) |
| Small key-addressed state | [`vite-hub/kv`](https://vitehub.dev/docs/server-primitives/kv) |
| Relational data | [`vite-hub/database`](https://vitehub.dev/docs/server-primitives/database) |
| Uploads and generated assets | [`vite-hub/blob`](https://vitehub.dev/docs/server-primitives/blob) |
| File-tree state and Sources | [`vite-hub/workspace`](https://vitehub.dev/docs/server-primitives/workspace) |
| Background delivery | [`vite-hub/queue`](https://vitehub.dev/docs/server-primitives/queue) |
| Durable long-running work | [`vite-hub/workflow`](https://vitehub.dev/docs/server-primitives/workflows) |
| Future or recurring work | [`vite-hub/schedule`](https://vitehub.dev/docs/server-primitives/schedule) |
| Isolated execution | [`vite-hub/sandbox`](https://vitehub.dev/docs/server-primitives/sandbox) |

Each package owns its Runtime Helpers and Vite Integration. Host-specific wiring stays behind ViteHub Provider Output, so app code can use stable imports instead of provider SDK plumbing.

Libraries and focused integrations can depend on any `@vite-hub/*` owner package directly.

## Learn More

- [Installation](https://vitehub.dev/docs/getting-started/installation)
- [First server primitive](https://vitehub.dev/docs/getting-started/first-server-primitive)
- [First Agent](https://vitehub.dev/docs/getting-started/first-agent)
- [Agent Definitions](https://vitehub.dev/docs/agents/agent-definitions)
- [Capabilities](https://vitehub.dev/docs/capabilities)
- [Server primitives](https://vitehub.dev/docs/server-primitives)
- [Runtime imports](https://vitehub.dev/docs/reference/import-paths)
- [Migrate to `vite-hub`](https://vitehub.dev/docs/getting-started/migration)

## Development

This repo uses Node 24, pnpm, and Vite+. Run `vp run verify` for the full local gate. Package scripts own package-local test, build, and typecheck behavior.
