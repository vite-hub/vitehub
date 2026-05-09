---
title: Agent runtime API
description: Reference for Agent exports and module options.
navigation.title: Runtime API
navigation.order: 4
icon: i-lucide-braces
frameworks: [vite, nitro]
---

## Exports

Runtime definitions import from `@vitehub/agent`:

```ts
import { defineAgent, defineTool, getAgent, runAgent, streamAgent } from '@vitehub/agent'
```

Agent run input uses `Message[]` from `@vitehub/messages`:

```ts
import type { Message, StreamEvent } from '@vitehub/agent'

interface AgentRunInput {
  messages?: Message[]
  prompt?: string | Message[]
}

type AgentStream = AsyncIterable<StreamEvent>
```

Vercel AI SDK remains the default model adapter, but AI SDK message objects are converted inside `@vitehub/agent` instead of being the public Chat-to-Agent contract.

Vite config imports from `@vitehub/agent/vite`:

```ts
import { hubAgent } from '@vitehub/agent/vite'
```

Nitro config uses the module:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
})
```

## Module options

```ts
type AgentRuntime = 'auto' | 'nitro' | 'vercel' | 'cloudflare-agents'
type AgentExecution = 'inline' | 'workflow' | 'sandbox'

interface AgentModuleOptions {
  route?: boolean | string
  runtime?: AgentRuntime
  execution?: AgentExecution
  imports?: boolean
  integrations?: {
    workflow?: 'auto' | boolean
    sandbox?: 'auto' | boolean
  }
  providers?: {
    model?: { provider?: 'auto' | 'vercel-ai-sdk' | string }
    state?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    scheduler?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    sandbox?: { provider?: 'auto' | 'cloudflare' | 'vercel' | string }
  }
}
```

Generated HTTP routes are disabled by default. Set `route: true` to expose discovered agents at `/agents/[agent]`, or pass a custom route string.
