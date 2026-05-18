---
title: Agent runtime API
description: Reference for Agent exports, inputs, context, and module options.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page for exact names and shapes. For setup, start with [Quickstart](./quickstart).

## Imports

```ts
import {
  bash,
  blob,
  db,
  defineAgent,
  defineCapability,
  getAgent,
  kv,
  mcp,
  runAgent,
  sandbox,
  skills,
  streamAgent,
} from '@vitehub/agent'
```

::fw{id="vite:dev vite:build"}
```ts
import { hubAgent } from '@vitehub/agent/vite'
```
::

::fw{id="nitro:dev nitro:build"}
```ts
export default defineNitroConfig({
  modules: ['@vitehub/agent/nitro'],
})
```
::

## Define an agent

```ts
defineAgent({
  description?: string
  capabilities?: AgentCapabilityDefinition[]
  instructions?: AgentAdapterInstructions
  model?: unknown
  provider?: 'ai-sdk' | 'tanstack-ai' | string
  run?: AgentRunHandler
  workspace?: string | ({ mode?: 'read' | 'write' } & WorkspaceAgentWorkspaceOptions)
})
```

Capabilities are the public model-facing extension surface. `provider` explicitly selects the model runtime; ViteHub does not infer it from installed packages or model object shape.

```ts
defineAgent({
  workspace: {
    mode: 'read',
    sources,
  },
  capabilities: [
    bash(),
  ],
  instructions: 'Use workspace sources.',
  model,
  provider: 'ai-sdk',
  options: {
    providerOptions: {
      openai: { reasoningEffort: 'medium' },
    },
  },
})
```

Provider option objects forward unknown fields to the underlying library so new provider options are not blocked on ViteHub releases.

Workspace agents do not attach workspace tools automatically. The `workspace` option defines the explicit primary filesystem boundary; capabilities decide what the model can use at runtime.

```ts
defineAgent({
  workspace: { mode: 'read', sources },
  capabilities: [
    bash(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
  provider: 'ai-sdk',
})
```

Use `bash()` for default read-only workspace shell inspection. Use `bash({ mode: 'write' })` only with `workspace.mode: 'write'`. Use inline or factory capabilities to expose raw tools:

```ts
defineAgent({
  capabilities: [
    defineCapability({
      id: 'custom-tools',
      tools: {
        lookup: {
          name: 'lookup',
          execute: async input => input,
        },
      },
    }),
  ],
  model,
  provider: 'ai-sdk',
})
```

## Run input

```ts
interface AgentRunInput {
  messages?: Message[]
  prompt?: string | Message[]
}
```

`Message` comes from `@vitehub/messages` and is re-exported by `@vitehub/agent`.

## Runtime context

```ts
interface AgentRuntimeContext {
  request?: Request
  runtime: 'nitro' | 'vercel' | 'cloudflare-agents' | 'unknown'
  runtimeConfig?: AgentRuntimeConfig
  waitUntil?: (promise: Promise<unknown>) => void
  capabilities?: AgentCapabilities
  memo: <T>(key: string, factory: () => T | Promise<T>) => T | Promise<T>
}
```

`run` receives a resolved context with `runtimeConfig` present.

## Module options

```ts
interface AgentModuleOptions {
  route?: boolean | string
  runtime?: 'auto' | 'nitro' | 'vercel' | 'cloudflare-agents'
  execution?: 'inline' | 'workflow' | 'sandbox'
  imports?: boolean
  integrations?: {
    workflow?: 'auto' | boolean
    sandbox?: 'auto' | boolean
  }
  providers?: {
    state?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    scheduler?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    sandbox?: { provider?: 'auto' | 'cloudflare' | 'vercel' | string }
  }
}
```

## Tool policy

```ts
const refundTool = {
  name: 'refund',
  description: 'Refund an order',
  policy: 'require-approval',
}
```

Tool policy metadata travels with the tool definition. Runtime enforcement belongs to the executor that receives the tool handle.
