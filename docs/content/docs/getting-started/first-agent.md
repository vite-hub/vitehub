---
title: First Agent
navigation.title: First Agent
description: Define a server-side Agent, call it from H3, and see the response.
layout: tutorial
navigation.order: 4
icon: i-lucide-bot
---

Build a small server that greets a name through an Agent. You will create an
Agent Definition, call it from an HTTP route, and check the returned JSON.

An Agent Definition declares the work to run. Its Driver performs that work.
This tutorial uses a function Driver, so you can learn the invocation path
without setting up a model or a provider account. You need Node.js 24.15 or
newer and `pnpm`. After you install the dependencies, the server runs offline.

::tutorial-step{title="Create the project"}
## Create the project

Create a folder for the app and install ViteHub, Vite, and H3. Vite builds the
server. H3 handles the HTTP request. Setting `type=module` lets Node.js use
the `import` syntax in the generated server.

```bash [commands/setup]
mkdir vitehub-agent-start
cd vitehub-agent-start
pnpm init
pnpm pkg set type=module
pnpm add vite-hub h3 vite
```

::

::tutorial-step{title="Configure the server build"}
## Configure the server build

Add `vitehub()` with the `node` preset and `agent: true`. Vite builds
`src/server.ts` into `dist/server.js`, and ViteHub discovers Agent Definitions
under `server/agents`.

```ts [vite.config.ts]
import { resolve } from "node:path"

import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  root: import.meta.dirname,
  appType: "custom",
  build: {
    outDir: "dist",
    rolldownOptions: {
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

::

::tutorial-step{title="Define the greeting Agent"}
## Define the greeting Agent

Create `server/agents/greeting.ts`. The file location gives this Agent the name
`greeting`. Its `driver.run` function receives the input prompt and returns a
JSON object. Here, the prompt contains the name to greet.

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

::

::tutorial-step{title="Call the Agent from H3"}
## Call the Agent from H3

Create `src/server.ts`. The `/greet` route reads a name from the request and
passes it as the Agent's prompt. `runAgent()` returns the Driver's result,
which H3 sends as JSON.

The second argument supplies resources for this request. `memo` lets ViteHub
reuse a value during one invocation. `waitUntil` handles background tasks.
This small server creates them explicitly. A framework integration can provide
these resources for you.

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

::

::tutorial-step{title="Run the Agent and see the response"}
## Run the Agent and see the response

Build the project and start the generated Node.js server. The server listens on
port `5173` unless you set `PORT`.

```bash [commands/build]
pnpm vite build
node dist/server.js
```

From another terminal, send a name to the H3 route.

```bash [commands/request]
curl -X POST http://localhost:5173/greet \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

You should receive this JSON. The name in your request passed through the
route and the Agent Driver:

```json [output/response.json]
{"text":"Hello, Ada. This result came from an Agent Invocation."}
```

::

## Next steps

Add only what your Agent needs:

- Read [Agent Definitions](/docs/agents/agent-definitions) to choose another Driver or add Channels, Workspace context, trusted caller settings, or hooks.
- Read [Capabilities](/docs/agents/capabilities) before you give a model tools, triggers, policy, metadata, or context values.
- Read [Invocations](/docs/agents/invocations) when the route needs streaming or failure handling.
