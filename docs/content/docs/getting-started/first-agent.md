---
title: First Agent
description: Define a server-side Agent, call it from H3, and see the response.
navigation.order: 4
icon: i-lucide-bot
---

An Agent is a server file that tells ViteHub what to run. Every Agent needs a
Driver, which can be a function, model, or coding harness such as Codex or Claude
Code, among others. You can add Capabilities, Channels, Workspace access, and
other options later.

This tutorial starts with a function that returns a fixed greeting. It runs
offline and needs no credentials.

::note
You need Node.js 24.15 or newer and `pnpm`. This project runs completely offline.
::

## Install ViteHub and the server packages

Create an empty project, then install ViteHub with Vite and H3.

```bash [Terminal]
mkdir vitehub-agent-start
cd vitehub-agent-start
pnpm init
pnpm pkg set type=module
pnpm add vite-hub h3 vite
```

## Configure the server build

Add `vitehub()` to the Vite config. Vite builds `src/server.ts` for Node.js, and
ViteHub discovers Agent Definitions under `server/agents`.

```ts [vite.config.ts]
import { resolve } from "node:path"

import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/server.ts"),
      output: { entryFileNames: "server.js" },
    },
    ssr: true,
  },
  plugins: [vitehub({
    preset: "node",
    agent: true,
    env: false,
  })],
  ssr: {
    external: ["vite-hub/agent"],
  },
})
```

## Define the greeting Agent

Create `server/agents/greeting.ts`. Its required `driver.run` function reads the
prompt and returns the greeting without calling a provider.

```ts [server/agents/greeting.ts]
import { defineAgent } from "vite-hub/agent"

export default defineAgent({
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

## Call the Agent from H3

`runAgent()` takes the Definition, runtime values for the current request, and
the invocation input. The route creates a new memo cache for each request,
identifies Vite as the runtime, and reports errors from background tasks.

```ts [src/server.ts]
import { createServer } from "node:http"

import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import { runAgent } from "vite-hub/agent"
import greeting from "../server/agents/greeting"

function createMemo() {
  const values = new Map<string, unknown>()

  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    return values.get(key) as T
  }
}

const app = new H3().post("/greet", async (event) => {
  const body = await readBody<{ name?: string }>(event) || {}

  return await runAgent(greeting, {
    memo: createMemo(),
    runtime: "vite",
    waitUntil: task => { void task.catch(error => console.error(error)) },
  }, {
    prompt: body.name?.trim() || "friend",
  })
})

const port = Number(process.env.PORT || 5173)

createServer(toNodeHandler(app)).listen(port, () => {
  console.log(`ViteHub Agents tutorial listening on http://localhost:${port}`)
})
```

The route imports the Definition directly, so the greeting returns in the same
request.

## Run the Agent and see the response

Build the project and start the generated Node.js server.

```bash [Terminal]
pnpm vite build
node dist/server.js
```

From another terminal, send a name to the H3 route.

```bash [Terminal]
curl -X POST http://localhost:5173/greet \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

The Agent returns the greeting:

```json [Response]
{"text":"Hello, Ada. This result came from an Agent Invocation."}
```

From here, add only what your Agent needs:

- Read [Agent Definitions](/docs/agents/agent-definitions) to choose another Driver or add Channels, Workspace context, trusted caller settings, or hooks.
- Read [Capabilities](/docs/capabilities) before you give a model tools, triggers, policy, metadata, or context values.
- Read [Invocations](/docs/agents/invocations) when the route needs streaming or failure handling.
