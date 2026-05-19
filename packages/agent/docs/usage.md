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
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
})
```

Use named exports when one file owns several agents:

```ts [server/agent.ts]
import { defineAgent } from '@vitehub/agent'

export const triager = defineAgent({
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
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
import { defineAgent, type AgentToolDefinition } from '@vitehub/agent'
import { getMessageText } from '@vitehub/agent'

const classifyTicket: AgentToolDefinition<{ message: string }, { queue: string; priority: string }> = {
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
}

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

`run` receives resolved runtime context and the agent input. Use it as the escape hatch when an official library API is not covered by a ViteHub adapter yet.

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

## Use Workspace capabilities

Use `defineAgent()` with a `workspace` option from a colocated agent config when an agent answers from ViteHub Workspace sources. `workspace` mounts the sources only; it does not expose model tools by itself.

Add `bash()` when the model should inspect the mounted files:

```ts [server/agents/data-sources/config.ts]
import { bash, defineAgent } from '@vitehub/agent'
import * as source from '@vitehub/workspace/source'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs', cache: { maxAge: 3600 } }),
    },
  },
  capabilities: [
    bash(),
  ],
  model,
  provider: 'ai-sdk',
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
  capabilities: [
    bash(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
  provider: 'ai-sdk',
})
```

Instruction parts can also be composed with an array:

```ts
export default defineAgent({
  workspace: {},
  capabilities: [
    bash(),
  ],
  instructions: [
    'Answer only from inspected workspace evidence.',
    async ({ fs }) => await fs.readFile('AGENTS.md'),
  ],
  model,
  provider: 'ai-sdk',
})
```

### Migration note

Workspace sources do not imply model tools. Replace older workspace agents that relied on root or adapter-level tools with explicit capabilities:

```diff
 import { bash, defineAgent } from '@vitehub/agent'

 export default defineAgent({
   workspace: { sources },
+  capabilities: [
+    bash(),
+  ],
+  model,
+  provider: 'ai-sdk',
 })
```

Use `bash({ mode: 'write' })` only with `workspace.mode: 'write'`. Raw tools should be wrapped in inline or factory capabilities instead of `defineAgent({ tools })`.
