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
import { aiSdkAdapter } from '@vitehub/agent/ai-sdk'

export default defineAgent({
  adapter: aiSdkAdapter({
    model,
    instructions: 'Triage support requests.',
  }),
})
```

Use named exports when one file owns several agents:

```ts [server/agent.ts]
import { defineAgent } from '@vitehub/agent'
import { aiSdkAdapter } from '@vitehub/agent/ai-sdk'

export const triager = defineAgent({
  adapter: aiSdkAdapter({
    model,
    instructions: 'Triage support requests.',
  }),
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

## Use Workspace tools

Use `defineAgent()` with a `workspace` option from a colocated agent config when an agent answers from ViteHub Workspace sources. `workspace` mounts the sources only; it does not expose model tools by itself.

Add a `tools` resolver when the model should inspect the mounted files:

```ts [server/agents/data-sources/config.ts]
import { defineAgent } from '@vitehub/agent'
import { aiSdkAdapter } from '@vitehub/agent/ai-sdk'
import * as source from '@vitehub/workspace/source'

export default defineAgent({
  workspace: {
    sources: {
      docs: source.github({ repo: 'acme/docs', cache: { maxAge: 3600 } }),
    },
  },
  adapter: aiSdkAdapter({
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
  }),
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
  adapter: aiSdkAdapter({
    instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
  }),
})
```

Instruction parts can also be composed with an array:

```ts
export default defineAgent({
  workspace: {},
  adapter: aiSdkAdapter({
    instructions: [
      'Answer only from inspected workspace evidence.',
      async ({ fs }) => await fs.readFile('AGENTS.md'),
    ],
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
  }),
})
```

### Migration note

Workspace sources no longer imply model tools. Replace older workspace agents that relied on implicit tools with an explicit resolver:

```diff
 export default defineAgent({
   workspace: { sources },
+  adapter: aiSdkAdapter({
+    tools: ({ workspace }) => workspace.tools.inspect(),
+    model,
+  }),
 })
```

Use `workspace.tools.none()` when a resolver needs to return an empty tool set, and reserve `workspace.tools.write()` for agents that intentionally receive mutable workspace access.

## Use Skills

Use `skills` when an agent should pick up reusable behavior from Markdown files in its workspace.

```ts [server/agents/assistant.ts]
import { defineAgent } from '@vitehub/agent'
import { aiSdkAdapter } from '@vitehub/agent/ai-sdk'

export default defineAgent({
  skills: true,
  adapter: aiSdkAdapter({
    model,
    instructions: 'Help the user with their work.',
    tools: developerTools,
  }),
})
```

Skill files live under `skills/` by default. The agent receives a compact Skill index with each Skill path. If the developer exposes workspace read tools, the agent can use those paths to load the full Skill body when needed. Prefer flat files for simple Skills:

```md [skills/receipt-tracking.md]
---
name: receipt-tracking
description: Track receipts from messages and attachments. Use when the user sends receipts, invoices, or expense screenshots.
---

# Receipt Tracking

When the user sends a receipt, extract merchant, date, amount, and currency.
```

Use folder Skills only when the Skill needs supporting files:

```txt
skills/receipt-tracking/SKILL.md
skills/receipt-tracking/EXAMPLES.md
```

Enable authoring when the agent should create or update Skills from user-confirmed drafts:

```ts [server/agents/assistant.ts]
export default defineAgent({
  skills: {
    authoring: true,
  },
  adapter: aiSdkAdapter({
    model,
    instructions: 'Help the user with their work.',
    tools: developerTools,
  }),
})
```

Authoring adds concise skill-writing guidance. It does not add a generated write tool; if the developer exposes a workspace `writeFile` tool, ViteHub validates writes that target the configured Skills directory before the underlying tool runs. Skills describe behavior; they should not name implementation-specific tools.
