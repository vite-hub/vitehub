---
title: Agent usage
description: Discover agents, expose routes, customize runs, and compose with Chat.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart).

## Discover agents

Agents are discovered from Nitro server files.

```txt
server/agents.ts
server/agents/triager.ts
server/agents/support/reviewer.ts
```

Use a default export for one agent per file:

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  model,
  instructions: 'Triage support requests.',
})
```

Use named exports when one file owns several agents:

```ts [server/agents.ts]
import { defineAgent } from '@vitehub/agent'

export const triager = defineAgent({
  model,
  instructions: 'Triage support requests.',
})
```

## Expose an HTTP route

Routes are disabled by default. Enable them when another server needs to call an agent over HTTP.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { hubAgent } from '@vitehub/agent/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAgent({
      route: true,
    }),
    nitro(),
  ],
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: {
    route: true,
  },
})
```
::

Pass a route string when `/agents/[agent]` does not fit your app.

## Customize a run

Use `run` when the default model call is not the right shape.

```ts [server/agents/support.ts]
import { defineAgent, defineTool } from '@vitehub/agent'
import { getMessageText } from '@vitehub/messages'

const classifyTicket = defineTool<{ message: string }, { queue: string; priority: string }>({
  name: 'classifyTicket',
  description: 'Classify a support request before queue handoff.',
  policy: ({ input }) => {
    const message = typeof input === 'object' && input && 'message' in input
      ? String(input.message)
      : ''

    return /refund|invoice|payment/i.test(message) ? 'require-approval' : 'allow'
  },
  execute: ({ message }) => ({
    queue: /down|broken|500|urgent/i.test(message) ? 'incident' : 'product',
    priority: /down|broken|500|urgent/i.test(message) ? 'urgent' : 'normal',
  }),
})

export default defineAgent({
  description: 'Triage support requests',
  async run({ input, waitUntil }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getMessageText(latest) : ''
    const ticket = await classifyTicket.execute?.({ message })

    waitUntil?.(Promise.resolve({ event: 'support.triaged', ticket }))

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
})
```

`run` receives resolved runtime context, the agent input, and helpers for creating or streaming the underlying model agent.

## Bind Chat to Agent

Chat owns the webhook and thread. Agent owns the model work.

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: 'triager',
  state,
  userName: 'Support Bot',
})
```

Use the object form to customize history, input, or response posting.

```ts [server/chat.ts]
export default defineChat({
  adapters,
  agent: {
    name: 'triager',
    history: {
      source: 'thread',
      maxMessages: 20,
    },
    hooks: {
      beforeRun({ input }) {
        return input
      },
    },
  },
  state,
  userName: 'Support Bot',
})
```

## Use Workspace tools

Use `defineAgent.workspace()` from a colocated workspace config when an agent answers from a ViteHub Workspace.

```ts [server/workspaces/data-sources/config.ts]
import { defineAgent } from '@vitehub/agent'
import * as source from '@vitehub/workspace/source'

export default defineAgent.workspace({
  sources: {
    docs: source.github({ repo: 'acme/docs', ref: 'main', mount: 'docs' }),
  },
  model,
})
```

`server/workspaces/<name>/config.ts` becomes both the workspace definition and the default agent named after the workspace directory. `AGENTS.md` is loaded as instructions by convention when it exists. Use `instructions: async ({ fs }) => await fs.readFile('custom.md')` when instructions live somewhere else.
