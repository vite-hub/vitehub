<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/vitehub-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset=".github/assets/vitehub-logo.png">
    <img alt="ViteHub" src=".github/assets/vitehub-logo.png" width="360">
  </picture>
</p>

<p align="center">
  Server APIs and portable Agents for any Vite host.
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

ViteHub adds a server layer to Vite. Call its Server Primitives directly from application code, or combine them with models and tools in an Agent. ViteHub keeps the application API consistent while its integrations handle local development and supported deployment hosts.

## Choose how to start

### Start with server primitives

Server Primitives give application code APIs for auth, environment values, storage, queues, workflows, schedules, sandboxes, workspace files, and more. Start with [your first Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive).

### Agents

Agents are named server-side actors. An Agent Definition selects how the Agent runs, which Capabilities it receives, and which Workspace files it can use. Start with [your first Agent](https://vitehub.dev/docs/getting-started/first-agent).

Agents may compose Server Primitives. Server Primitives never require Agents.

## Install ViteHub

Install the framework distribution in a Vite application:

```bash
pnpm add vite-hub
```

Register the Vite integration:

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

Requirements: Node 24.15 or newer, Vite 8 or newer, and a server app with `vite.config.ts`.

## Run your first Agent

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

Add Capabilities when the Agent needs tools, storage, Workspace files, chat, product events, or external systems. An Agent receives only the Capabilities you select.

## How Agents work

- An **Agent Definition** declares one Agent and selects its Agent Driver.
- An **Agent Driver** runs an Agent Invocation with a model, a coding provider, or application code.
- An **Agent Invocation** is one runtime request to an Agent.
- **Capabilities** add selected tools, instructions, triggers, policies, or context.
- A **Workspace** gives an Agent a file tree. **Sources** mount read-only files or remote content into it.
- Vite integrations discover definitions and prepare the files and host configuration needed at runtime.

Server code can call primitives directly. Agents do not receive every primitive by default; attach a Capability when the model needs one.

## Server primitives

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
| Delayed or recurring work | [`vite-hub/schedule`](https://vitehub.dev/docs/server-primitives/schedule) |
| Isolated execution | [`vite-hub/sandbox`](https://vitehub.dev/docs/server-primitives/sandbox) |

Each package provides its server API and Vite integration. Application code uses the same imports while the integration connects them to the selected host.

Libraries and focused integrations can depend on any `@vite-hub/*` owner package directly.

## Learn more

- [Installation](https://vitehub.dev/docs/getting-started/installation)
- [First server primitive](https://vitehub.dev/docs/getting-started/first-server-primitive)
- [First Agent](https://vitehub.dev/docs/getting-started/first-agent)
- [Agent Definitions](https://vitehub.dev/docs/agents/agent-definitions)
- [Capabilities](https://vitehub.dev/docs/capabilities)
- [Server primitives](https://vitehub.dev/docs/server-primitives)
- [Runtime imports](https://vitehub.dev/docs/reference/import-paths)
- [Migrate to `vite-hub`](https://vitehub.dev/docs/getting-started/migration)

## Development

This repo uses Node 24.15 or newer, pnpm, and Vite+. Run `vp run verify` for the full local gate. Package scripts own package-local test, build, and typecheck behavior.
