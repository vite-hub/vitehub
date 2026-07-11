---
title: First Agent
description: Define a deterministic Agent and run one observable Agent Invocation.
navigation.order: 4
icon: i-lucide-bot
---

An Agent Definition names a server-side actor and the Agent Driver that runs
it. Start with application-owned logic so the first proof needs no credential,
network request, or model billing.

::note
You need Node.js 24 or newer and `pnpm`. The quickstart runs completely offline.
::

## Install Agents

Create an empty project and install ViteHub Agents with Vite and H3.

```bash [Terminal]
mkdir vitehub-agent-start
cd vitehub-agent-start
pnpm init
pnpm pkg set type=module
pnpm add @vite-hub/agent h3 vite
```

## Configure the server build

The first proof imports its Agent Definition directly, so it only needs a
server build. Add Agent discovery when the application needs a named registry
or host integration.

```ts [vite.config.ts]
import { resolve } from "node:path"

import { defineConfig } from "vite"

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
  ssr: {
    external: ["@vite-hub/agent"],
  },
})
```

## Define the Agent

Create a deterministic Agent Driver. `driver.run` keeps the first invocation
observable and free from provider prerequisites.

```ts [server/agents/greeting.ts]
import { defineAgent } from "@vite-hub/agent"

export default defineAgent({
  description: "Returns a deterministic greeting for the first tutorial.",
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

The route imports this Definition directly. Keeping it under `server/agents`
makes the Agent boundary easy to discover and review.

## Run one Agent Invocation

Create one H3 route that passes host runtime context separately from invocation
input. `memo`, `runtime`, and `waitUntil` are explicit because `runAgent()` does
not depend on framework globals.

Create the invocation-scoped memoizer first. It initializes each key once, and
the route creates a fresh cache for every request.

```ts [src/memo.ts]
export function createMemo() {
  const values = new Map<string, unknown>()

  return <T>(key: string, create: () => T): T => {
    if (!values.has(key)) values.set(key, create())
    return values.get(key) as T
  }
}
```

```ts [src/server.ts]
import { createServer } from "node:http"

import { runAgent } from "@vite-hub/agent"
import { H3, readBody } from "h3"
import { toNodeHandler } from "h3/node"
import greeting from "../server/agents/greeting"
import { createMemo } from "./memo"

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

## Run the server

Build and start the generated Node.js entry.

```bash [Terminal]
pnpm vite build
node dist/server.js
```

Invoke the Agent from another terminal.

```bash [Terminal]
curl -X POST http://localhost:5173/greet \
  -H 'content-type: application/json' \
  -d '{"name":"Ada"}'
```

The deterministic invocation returns an inspectable result:

```json [Response]
{"text":"Hello, Ada. This result came from an Agent Invocation."}
```

You can now replace `driver.run` with a model or coding harness while keeping
the Agent Definition and invocation boundary.

## Next steps

- Follow the longer [Agents tutorial](/blog/agents) to upgrade this Agent to an AI SDK model.
- Read [Agent Definitions](/docs/agents/agent-definitions) for every Agent Driver shape.
- Read [Invocations](/docs/agents/invocations) for streaming, trusted context, and failure handling.
- Read [Capabilities](/docs/agents/capabilities) before exposing tools or data.
