---
title: First Agent
navigation.title: First Agent
description: Add an offline greeting Agent to your app, call it from a server route, and check its response.
layout: tutorial
codePanel: true
navigation.order: 4
navigation.group: Get started
icon: i-lucide-bot
---

Add an Agent that greets a name and returns JSON. An Agent Definition declares
the work, and its Driver runs it. Here the Driver is a function, so it runs
offline and needs no model account or credentials.

## Before you start

Complete [Installation](/docs/getting-started/installation), check
`/api/health`, and continue in that app with Node.js 22.22 or newer and pnpm.

::run-tutorial{to="/learn/first-agent"}
::

::tutorial-step{title="Enable Agents"}
## Enable Agents

Install the Agent package:

```bash [commands/install-agent]
pnpm add @vite-hub/agent
```

Add `agent: true` to the ViteHub options. Set `workflow: false`, because this
Agent finishes inside the HTTP request. Keep your other features.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: "node",
    agent: true,
    workflow: false,
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { nitro } from 'nitro/vite'
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      agent: true,
      workflow: false,
    }),
    nitro(),
  ],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      host: "node",
      agent: true,
      workflow: false,
    }),
  ],
})
```
::::
:::

::

::tutorial-step{title="Define the greeting Agent"}
## Define the greeting Agent

Create `server/agents/greeting.ts`. ViteHub names the Agent `greeting` from
its file path. `runtime: false` runs it inline. The function Driver gets the
name as its prompt and returns text.

```ts [server/agents/greeting.ts]
import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  runtime: false,
  driver: {
    run({ prompt }) {
      const name = typeof prompt === "string" ? prompt : "friend"

      return {
        text: `Hello, ${name}. This result came from an Agent Invocation.`,
      }
    },
  },
})
```

::

::tutorial-step{title="Call the Agent from a route"}
## Call the Agent from a route

Create `server/api/greet.post.ts`. Nitro and Nuxt serve it at
`POST /api/greet`. The explicit H3 imports remove the need for auto-imports.

```ts [server/api/greet.post.ts]
import { defineEventHandler, readBody } from "h3"
import { runAgent } from "vite-hub/agent"
import greeting from "../agents/greeting"

export default defineEventHandler(async (event) => {
  const body = await readBody<{ name?: string }>(event)
  const [error, result] = await runAgent(greeting, {
    prompt: body?.name?.trim() || "friend",
  })

  if (error) throw error
  return { text: result.text }
})
```

`runAgent()` creates a memo cache and waits for the background work of the
run. It returns `[undefined, result]` on success or `[error, undefined]` on
failure. Check the error before you read `result.text`.

For request metadata or host bindings, pass the public
[`getRuntimeContext(event)` adapter](/docs/reference/runtime-context) as
`runAgent(agent, input, { runtimeContext: getRuntimeContext(event) })`. The
greeting needs only its prompt.

::

::tutorial-step{title="Run the Agent"}
## Run the Agent

Restart the app to load the new configuration:

```bash [commands/dev]
pnpm dev
```

In another terminal, send a name:

```bash [commands/request]
curl -X POST http://localhost:3000/api/greet \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

You should receive this JSON. It proves the route called the function Driver
without a model request.

```json [output/response.json]
{"text":"Hello, Ada. This result came from an Agent Invocation."}
```

Sending `{}` greets `friend`.

To check the Vite app's production server, stop development, run the
Installation scripts, and repeat the request:

```bash [commands/build]
pnpm build
pnpm start
```

In Nuxt, run `pnpm build` and `node .output/server/index.mjs` instead.

::

## Continue with a model

A model Driver needs network access and a billed provider account. To use a
model string through Vercel AI Gateway, install `ai` and set
`AI_GATEWAY_API_KEY` in your server environment. Keep the key out of client
code and version control. Each request can cost money.

For model output, replace `driver.run` with `driver.model` and
`driver.instructions`. [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver)
shows the supported forms. Model replies vary, so the exact greeting above is
only the offline check.

[Build a chat app](/docs/agents/build-a-chat-app) adds a chat UI with
streaming, an offline Driver, and an optional model Driver. Read
[Capabilities](/docs/agents/capabilities) when the Agent needs a tool or
stored data.

## Related guides

[Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel)
checks the same inline Agent on two hosts.
[Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks)
compares execution and state models.
