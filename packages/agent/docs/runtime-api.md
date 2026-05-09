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
import { defineAgent, getAgent, runAgent, streamAgent } from '@vitehub/agent'
```

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
  route?: string | false
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

The default route is `/agents/[agent]`.
