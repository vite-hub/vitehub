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
the work; its Driver runs it. This first Driver is a function, so it runs
offline after installation and needs no model account or credentials.

## Before you start

Complete [Installation](/docs/getting-started/installation) and check
`/api/health` in your app. You need Node.js 24.15 or newer and pnpm.
Continue in that project directory. The configuration below uses the Vite
and Nitro path. In Nuxt, put the same ViteHub options in your module config;
the Agent Definition and server route stay the same.

::tutorial-step{title="Enable Agents"}
## Enable Agents

Install the Agent package:

```bash [commands/install-agent]
pnpm add @vite-hub/agent
```

Add `agent: true` to the ViteHub options. Set `workflow: false` because this
Agent finishes inside the HTTP request. Keep other features you already use.

```ts [vite.config.ts]
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({
      preset: "node",
      agent: true,
      workflow: false,
    }),
  ],
})
```

::

::tutorial-step{title="Define the greeting Agent"}
## Define the greeting Agent

Create `server/agents/greeting.ts`. ViteHub discovers the name `greeting` from
its file path. `runtime: false` makes the Agent run inline. The function
Driver receives the name as its prompt and returns a text result.

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

Create `server/api/greet.post.ts`. Nitro and Nuxt serve this file at
`POST /api/greet`. Import the H3 helpers explicitly so the code does not
depend on framework auto-imports.

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
  return result
})
```

This `runAgent(agent, input)` form creates a memo cache and waits for its
background work. It returns `[null, result]` on success or `[Error, null]` on
failure. Check the error before returning the result.

For request metadata or host bindings, use the public
[`getRuntimeContext(event)` adapter](/docs/reference/runtime-context) with
`runAgent(agent, runtime, input)`. That form returns the result directly and
throws failures. The greeting needs only its prompt.

::

::tutorial-step{title="Run the Agent"}
## Run the Agent

Restart the app after changing its configuration:

```bash [commands/dev]
pnpm dev
```

In another terminal, send a name:

```bash [commands/request]
curl -X POST http://localhost:3000/api/greet \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

You should receive this JSON. It proves that the route called the function
Driver and returned its result without a model request.

```json [output/response.json]
{"text":"Hello, Ada. This result came from an Agent Invocation."}
```

Change the name and repeat the request. Sending `{}` returns a greeting for
`friend`.

To check the Vite app's production server, stop development first, then run
the scripts from Installation and repeat the same request:

```bash [commands/build]
pnpm build
pnpm start
```

In Nuxt, run `pnpm build` and `node .output/server/index.mjs` instead.

::

## Continue with a model

A model Driver needs network access and a billed provider account. Install
`ai` and set `AI_GATEWAY_API_KEY` in your server environment before using a
model string through Vercel AI Gateway. Keep the key out of client code and
version control. Each request can incur provider charges.

Replace `driver.run` with a `driver.model` and `driver.instructions` when
you are ready for model output. [Agent Drivers](/docs/agents/agent-drivers#use-a-model-backed-driver)
shows the supported forms. Model responses vary, so the exact greeting above
is only the offline check.

Continue with [Build a chat app](/docs/agents/build-a-chat-app) for a complete
chat UI with streaming, an offline Driver, and an optional model Driver. Read
[Capabilities](/docs/agents/capabilities) when the Agent needs a tool or
access to stored data.

## Related guides

Use [Deploy an Agent on Cloudflare and Vercel](/docs/guides/deploy-agent-cloudflare-vercel)
to check the same inline Agent on two hosts. Read
[Choose a TypeScript Agent framework](/docs/guides/typescript-agent-frameworks)
to compare execution and state models before expanding the app.
