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
  defineCapability,
  getAgent,
  runAgent,
  streamAgent,
  usageTelemetry,
  vercelAiGatewayPricing,
} from '@vitehub/agent'
import {
  bash,
  blob,
  db,
  kv,
  mcp,
  sandbox,
  skills,
} from '@vitehub/agent/capabilities'
```

In Nitro, the module auto-imports `defineAgent` for discovered agent definitions. Capability factories such as `bash()` stay explicit imports because they expose model-facing tools.

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
  hooks?: AgentInvocationHooks
  instructions?: AgentAdapterInstructions
  model?: unknown
  adapter?: 'ai-sdk' | 'tanstack-ai' | string
  adapterOptions?: Record<string, unknown>
  run?: AgentRunHandler
  workspace?: string | ({ mode?: 'read' | 'write' } & WorkspaceAgentWorkspaceOptions)
})
```

Capabilities are the public model-facing extension surface. `adapter` explicitly selects the model adapter; ViteHub does not infer it from installed packages or model object shape.

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
  adapter: 'ai-sdk',
  adapterOptions: {
    providerOptions: {
      openai: { reasoningEffort: 'medium' },
    },
  },
})
```

Adapter options forward settings to the selected model adapter. For AI SDK adapters, `providerOptions` remains the place for model-provider-specific options.

Workspace agents do not attach workspace tools automatically. The `workspace` option defines the explicit primary filesystem boundary; capabilities decide what the model can use at runtime.

```ts
defineAgent({
  workspace: { mode: 'read', sources },
  capabilities: [
    bash(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
  adapter: 'ai-sdk',
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
  adapter: 'ai-sdk',
})
```

## Agent invocation hooks

Use `agent:finish` to observe a completed Agent Invocation. The hook runs after object results are rendered and after streamed or `Response` results are consumed or canceled.

```ts
defineAgent({
  hooks: {
    'agent:finish'(event) {
      const usage = event.extensions.get<AgentUsageRecord>('usage-telemetry')
    },
  },
  capabilities: [
    usageTelemetry(),
  ],
  model,
  provider: 'ai-sdk',
})
```

```ts
interface AgentFinishEvent {
  input: AgentRunInput
  result?: unknown
  error?: unknown
  runtime: ResolvedAgentRuntimeContext
  invocation: {
    durationMs: number
    run?: AgentRunMetadata
  }
  extensions: {
    get<T = unknown>(capabilityId: string): T | undefined
  }
}
```

Capabilities can expose optional data on finish events through extension keys that match their Capability ID. Return `undefined` to omit the extension value for that invocation.

```ts
defineCapability({
  id: 'audit-log',
  output(context) {
    context.finish.provide(event => event.result)
  },
})
```

ViteHub-owned usage telemetry uses `usage-telemetry`.

## Run input

```ts
interface AgentRunInput {
  messages?: Message[]
  prompt?: string | Message[]
}
```

`Message` comes from `@vitehub/agent` and is re-exported by `@vitehub/agent`.

## Agent usage telemetry

```ts
usageTelemetry({
  includeRaw?: boolean
  pricing?: AgentUsagePricing
})
```

```ts
interface AgentUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  inputTokenDetails?: Record<string, number>
  outputTokenDetails?: Record<string, number>
  raw?: unknown
}

interface AgentUsageRecord {
  usage?: AgentUsage
  model?: { id?: string; provider?: string }
  response?: { id?: string; timestamp?: Date | string; finishReason?: unknown }
  latency?: { durationMs?: number; timeToFirstTokenMs?: number; tokensPerSecond?: number }
  cost?: AgentUsageCost
  run?: Partial<AgentRunMetadata>
  raw?: unknown
}
```

`usageTelemetry()` uses the Capability output phase. It normalizes finished object results only; streamed `Response` and async iterable results are returned unchanged. When an Agent Finish Hook is configured, the same record is available through `event.extensions.get('usage-telemetry')`.

```ts
usageTelemetry({
  pricing: vercelAiGatewayPricing(),
})
```

## Runtime context

```ts
interface AgentRuntimeContext {
  request?: Request
  runtime: 'nitro' | 'vercel' | 'cloudflare-agents' | 'unknown'
  waitUntil?: (promise: Promise<unknown>) => void
  capabilities?: AgentCapabilities
  memo: <T>(key: string, factory: () => T | Promise<T>) => T | Promise<T>
}
```

Agent callbacks receive runtime host metadata, but not raw runtime config. Use `useServerEnv()` from `#vitehub/env/server` for app-owned Runtime Env values.

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
