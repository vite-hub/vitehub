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
server/agent.ts
server/agents/triager.ts
server/agents/context/config.ts
server/agents/support/reviewer.ts
```

Use a default export for one agent per file:

```ts [server/agents/triager.ts]
import { defineAgent } from '@vitehub/agent'

export default defineAgent({
  provider: 'ai-sdk',

    model,
    instructions: 'Triage support requests.',
})
```

Use named exports when one file owns several agents:

```ts [server/agent.ts]
import { defineAgent } from '@vitehub/agent'

export const triager = defineAgent({
  provider: 'ai-sdk',

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
}
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
  agent: {
    route: true,
  },
}
```
::

Pass a route string when `/agents/[agent]` does not fit your app.

## Customize a run

Use `run` when the default model call is not the right shape.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { getAgentMessageText } from '@vitehub/agent'

const classifyTicket = {
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
})

export default defineAgent({
  description: 'Triage support requests',
  async run({ input, waitUntil }) {
    const latest = input.messages?.at(-1)
    const message = latest ? getAgentMessageText(latest) : ''
    const ticket = await classifyTicket.execute?.({ message })

    waitUntil?.(Promise.resolve({ event: 'support.triaged', ticket }))

    return {
      raw: { ticket },
      text: ticket
        ? `Queued for ${ticket.queue} with ${ticket.priority} priority.`
        : 'Unable to classify the support request.',
    }
  },
}
```

`run` receives resolved runtime context and the agent input. Use it as the escape hatch when an official library API is not covered by a ViteHub adapter yet.

## Bind Chat to Agent

The chat capability owns webhook binding and thread output inside the agent.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  adapter,
  capabilities: [
    chat({
      adapters,
    }),
  ],
}
```

Enable history when the current chat thread should be replayed into the next agent run.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { chat } from '@vitehub/agent/capabilities'

export default defineAgent({
  workspace: 'support',
  adapter,
  capabilities: [
    chat({
      adapters,
      history: {
        source: 'thread',
        maxMessages: 20,
      },
      hooks: {
        agent: {
          beforeRun({ input }) {
            return input
          },
        },
      },
    }),
  ],
}
```

## Use Workspace tools

Use `defineAgent()` with a `workspace` option from a colocated agent config when an agent answers from ViteHub Workspace sources. `workspace` mounts the sources only; it does not expose model tools by itself.

Add a `tools` resolver when the model should inspect the mounted files:

```ts [server/agents/data-sources/config.ts]
import { defineAgent } from '@vitehub/agent'
import * as source from '@vitehub/workspace/source'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs', cache: { maxAge: 3600 } }),
    },
  },
  provider: 'ai-sdk',

    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
})
```

`server/agents/<name>/config.ts` becomes both the agent definition and an implicit workspace definition. Workspace files are not loaded as model instructions by convention. If you want to use `AGENTS.md`, opt in explicitly and keep command syntax guidance out of the file; the workspace shell tool describes its supported syntax through adapter metadata.

```ts [server/agents/data-sources/config.ts]
export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs' }),
    },
  },
  provider: 'ai-sdk',

    instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
})
```

Instruction parts can also be composed with an array:

```ts
export default defineAgent({
  workspace: {},
  provider: 'ai-sdk',

    instructions: [
      'Answer only from inspected workspace evidence.',
      async ({ fs }) => await fs.readFile('AGENTS.md'),
    ],
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
})
```

### Migration note

Workspace sources no longer imply model tools. Replace older workspace agents that relied on implicit tools with an explicit resolver:

```diff
 export default defineAgent({
   workspace: { sources },
+  provider: 'ai-sdk',

+    tools: ({ workspace }) => workspace.tools.inspect(),
+    model,
+  }),
 })
```

Use `workspace.tools.none()` when a resolver needs to return an empty tool set, and reserve `workspace.tools.write()` for agents that intentionally receive mutable workspace access.
