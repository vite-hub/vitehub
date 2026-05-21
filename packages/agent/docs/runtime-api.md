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
import {
  callsTool,
  defineEval,
  doesNotCallTool,
  doesNotLeakSource,
  staysUnderTokenBudget,
  textContains,
} from '@vitehub/agent/eval'
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

`usageTelemetry()` uses the Capability output phase. It normalizes finished object results only; streamed `Response` and async iterable results are returned unchanged.

```ts
usageTelemetry({
  pricing: vercelAiGatewayPricing(),
})
```

## Agent evaluations

Agent evaluations use the Agent Definition's Runtime Config type. `@vitehub/agent/eval` does not depend on `@vitehub/env`; ViteHub Env is one optional producer of values passed through `runtimeConfig`.

```ts
defineEval({
  agent?: AgentInput | (() => MaybePromise<AgentInput>)
  name?: string
  runtimeConfig?: AgentRuntimeConfig | (() => MaybePromise<AgentRuntimeConfig>)
  scenarios: AgentEvalScenario[]
  scorers?: AgentScorer[]
  variants?: AgentEvalVariant[]
  workspace?: string
})
```

```ts
interface AgentEvalScenario {
  name: string
  input: AgentRunInput
  metadata?: unknown
  scorers?: AgentScorer[]
}

interface AgentEvalVariant {
  name: string
  instructions?: string | string[]
  model?: unknown
}

interface AgentScore {
  score: number
  passed?: boolean
  reason?: string
  metadata?: unknown
}
```

Built-in scorers are `textContains()`, `doesNotLeakSource()`, `callsTool()`, `doesNotCallTool()`, and `staysUnderTokenBudget()`.

When `agent` is omitted, `defineEval()` imports the Agent Definition by convention. `name.eval.ts` resolves to sibling `name.ts`; folder-level `eval.ts` resolves to sibling `config.ts`.

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
