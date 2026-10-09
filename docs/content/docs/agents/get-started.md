---
title: Define your first Agent
description: Build an offline greeting Agent and call it from a server route.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
navigation.group: Start
icon: i-lucide-rocket
---

Build a greeting endpoint that returns `Hello, Ada!` without calling a model. You will define an Agent in one file, send it a prompt from a server route, and handle its result. The same route can call a model-backed Agent later.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. This example uses Nitro to serve the API route and needs no account or API key. If you need an app first, follow [First Agent](/docs/getting-started/first-agent).

::tutorial-step{title="Install and configure"}
## Install and configure

Install the server packages. If your app already has a Vite config, add these plugins to it and keep its existing plugins.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite
```

Register the Agent integration in `vite.config.ts`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', agent: true }), nitro() as never],
})
```

::

::tutorial-step{title="Define the Agent"}
## Define the Agent

Create `server/agents/greeting.ts`. The file name becomes the Agent name.

The Driver is the function that does the work. Here it receives the prompt, chooses a name, and returns a text result. It makes no model call.

```ts [server/agents/greeting.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    run({ prompt }) {
      const name = typeof prompt === 'string' ? prompt : 'friend'
      return { text: `Hello, ${name}!` }
    },
  },
})
```

The function Driver owns the whole run. Replace it with a model Driver when the
application needs generation or tools.
::

::tutorial-step{title="Call and verify the Agent"}
## Call and verify the Agent

`runAgent()` returns an error/result tuple. Check the error before returning the result so a failed invocation cannot look like a successful greeting.

```ts [server/api/greeting.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runAgent } from 'vite-hub/agent'
import greeting from '../agents/greeting'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const [error, result] = await runAgent(greeting, { prompt })
  if (error) throw error
  return result
})
```

Start Vite and send one request:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl -X POST http://localhost:5173/api/greeting \
  -H 'content-type: application/json' \
  -d '{"prompt":"Ada"}'
```

The response is `{ "text": "Hello, Ada!" }`. Build and inspect the discovered
Agent before deploying:

```bash [commands/inspect]
pnpm vite build
pnpm vitehub inspect definitions --kind agent
```

Continue with [Agent Drivers](/docs/agents/agent-drivers), [Capabilities](/docs/agents/capabilities), and [Workspace context](/docs/agents/workspace-context).
::
