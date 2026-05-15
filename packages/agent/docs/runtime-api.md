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
  defineAgent,
  defineTool,
  getAgent,
  runAgent,
  streamAgent,
} from '@vitehub/agent'
import { aiSdkAdapter } from '@vitehub/agent/ai-sdk'
import { tanstackAiAdapter } from '@vitehub/agent/tanstack-ai'
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
  adapter?: AgentAdapter | AgentAdapterFactory
  run?: AgentRunHandler
  workspace?: WorkspaceAgentWorkspaceOptions
})
```

Adapters own library-specific model, instruction, tool, and generation options. ViteHub owns runtime context, message input, tool policy, workspace integration, and chat handoff.

```ts
defineAgent({
  adapter: aiSdkAdapter({
    model,
    instructions: 'Use workspace sources.',
    tools: ({ workspace }) => workspace.tools.inspect(),
    options: {
      providerOptions: {
        openai: { reasoningEffort: 'medium' },
      },
    },
  }),
})
```

Use `tanstackAiAdapter()` from `@vitehub/agent/tanstack-ai` for TanStack AI. Adapter option objects forward unknown fields to the underlying library so new provider options are not blocked on ViteHub releases.

Workspace agents do not attach workspace tools automatically. The `workspace` option defines the source mounts; the `tools` resolver decides what the model can use at runtime.

```ts
defineAgent({
  workspace: { sources },
  adapter: aiSdkAdapter({
    instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
    tools: ({ workspace }) => workspace.tools.inspect(),
    model,
  }),
})
```

The resolver receives the same runtime context as `instructions`, plus `fs` and the workspace facade. Use `workspace.tools.inspect()` for the default read-only shell inspection tool, `workspace.tools.none()` for no tools, and `workspace.tools.write()` only with mutable workspace access.

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
    model?: { provider?: 'auto' | 'ai-sdk' | 'tanstack-ai' | string }
    state?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    scheduler?: { provider?: 'auto' | 'memory' | 'cloudflare-agents' | string }
    sandbox?: { provider?: 'auto' | 'cloudflare' | 'vercel' | string }
  }
}
```

## Tool policy

```ts
defineTool({
  name: 'refund',
  description: 'Refund an order',
  policy: 'require-approval',
})
```

Tool policy metadata travels with the tool definition. Runtime enforcement belongs to the executor that receives the tool handle.
