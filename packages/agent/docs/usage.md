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
  adapter: 'ai-sdk',
})
```

Use named exports when one file owns several agents:

```ts [server/agent.ts]
import { defineAgent } from '@vitehub/agent'

export const triager = defineAgent({
  instructions: 'Triage support requests.',
  model,
  adapter: 'ai-sdk',
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

## Track model usage

Use `usageTelemetry()` when a finished agent result should include normalized model usage and an accounting record.

```ts [server/agents/triager.ts]
import { defineAgent, usageTelemetry, vercelAiGatewayPricing } from '@vitehub/agent'

export default defineAgent({
  capabilities: [
    usageTelemetry({
      pricing: vercelAiGatewayPricing(),
    }),
  ],
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
})
```

`result.usage` stays compact and model-focused. When `usageTelemetry()` is attached, `result.usageRecord` includes the normalized usage plus model, response, run, latency, and optional cost fields when they are available.

```ts
const result = await runAgent(agent, context, {
  prompt: 'Summarize the ticket.',
})

result.usage
result.usageRecord?.cost
```

The capability does not define export callbacks or persistence hooks. Use the Agent Finish Hook to export, log, or sync completed usage records.

```ts
export default defineAgent({
  capabilities: [
    usageTelemetry({
      pricing: vercelAiGatewayPricing(),
    }),
  ],
  hooks: {
    'agent:finish'(event) {
      const usage = event.extensions.get('usage-telemetry')
      if (usage) event.runtime.waitUntil(syncUsage(usage))
    },
  },
  instructions: 'Triage support requests.',
  model,
  provider: 'ai-sdk',
})
```

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
import { defineAgent } from '@vitehub/agent'
import { bash } from '@vitehub/agent/capabilities'
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
  adapter: 'ai-sdk',
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
  adapter: 'ai-sdk',
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
  adapter: 'ai-sdk',
})
```

### Migration note

Workspace sources do not imply model tools. Replace older workspace agents that relied on root or adapter-level tools with explicit capabilities:

```diff
 import { defineAgent } from '@vitehub/agent'
+import { bash } from '@vitehub/agent/capabilities'

 export default defineAgent({
   workspace: { sources },
+  capabilities: [
+    bash(),
+  ],
+  model,
+  adapter: 'ai-sdk',
 })
```

Use `bash({ mode: 'write' })` only with `workspace.mode: 'write'`. Raw tools should be wrapped in inline or factory capabilities.

## Use fetch capabilities

Use `fetch()` when the model should call declared read-oriented HTTP tools. It supports JSON and text resources in v1:

```ts [server/agents/status/config.ts]
import { defineAgent } from '@vitehub/agent'
import { fetch } from '@vitehub/agent/capabilities'
import { useServerEnv } from '#vitehub/env/server'

export default defineAgent({
  capabilities: [
    fetch({
      tools: {
        checkRegionStatus: {
          description: 'Fetch current service status for a region.',
          request: ({ region }) => {
            const env = useServerEnv()
            return {
              url: 'https://status.example.com/api/region',
              query: { region },
              headers: {
                authorization: `Bearer ${env.status.token.unseal()}`,
              },
            }
          },
          responseType: 'json',
        },
      },
    }),
  ],
  model,
  adapter: 'ai-sdk',
})
```

The fetch Capability is query-only. Use it for stable read-style `GET`, `HEAD`, and `POST` requests; side-effectful API calls need a separate Capability design with explicit policy.

## Use durable memory

Memory stores expose scoped records through model tools. Configure at least one explicit scope value so records do not bleed across tenants, projects, users, or agents.

```ts [server/agents/support.ts]
import { defineAgent } from '@vitehub/agent'
import { memory, workspaceJsonlMemoryStore } from '@vitehub/agent/capabilities'

export default defineAgent({
  capabilities: [
    memory({
      stores: {
        agent: {
          adapter: workspaceJsonlMemoryStore(),
          read: {
            preload: [{ kind: 'procedural', pinned: true }],
          },
          scope: { agent: 'support' },
          write: { mode: 'tool', policy: 'require-approval' },
        },
      },
    }),
  ],
  model,
  adapter: 'ai-sdk',
})
```

The default JSONL file is `.vitehub/memory.jsonl`. Pass `workspaceJsonlMemoryStore({ path })` to choose another workspace path.

When tools omit `store`, memory uses the `agent` store if it exists, or the only configured store. If multiple non-`agent` stores are configured, tool calls must pass `store` explicitly.

Read permissions are enforced per selected store. A store with `read.tools.search: false` or `read.tools.read: false` cannot be reached through that tool even when another store exposes it.

Thread IDs are recorded in memory provenance for writes, but they are not added to the record scope automatically. Add thread scoping explicitly when records should be isolated per chat thread:

```ts
memory({
  stores: {
    agent: {
      adapter: workspaceJsonlMemoryStore(),
      scope: context => ({ agent: 'support', thread: context.run?.threadId }),
    },
  },
})
```
