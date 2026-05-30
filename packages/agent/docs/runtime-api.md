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
} from '@vite-hub/agent'
import {
  blob,
  chat,
  db,
  getTranscriptionResults,
  kv,
  mcp,
  sandbox,
  skills,
  transcribe,
  usageTelemetry,
  vercelAiGatewayPricing,
  workspaceShell,
} from '@vite-hub/agent/capabilities'
import {
  callsTool,
  defineEval,
  doesNotCallTool,
  doesNotLeakSource,
  staysUnderTokenBudget,
  textContains,
} from '@vite-hub/agent/eval'
```

In Nitro, the module auto-imports `defineAgent` for discovered agent definitions. Official Capability factories such as `chat()` and `workspaceShell()` stay explicit imports from `@vite-hub/agent/capabilities`.

::fw{id="vite:dev vite:build"}
```ts
import { hubAgent } from '@vite-hub/agent/vite'
```
::

::fw{id="nitro:dev nitro:build"}
```ts
export default defineNitroConfig({
  modules: ['@vite-hub/agent/nitro'],
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
  adapterOptions?: Record<string, unknown>
  run?: AgentRunHandler
  workspace?: string | ({ mode?: 'read' | 'write' } & WorkspaceAgentWorkspaceOptions)
})
```

Capabilities are the public model-facing extension surface. `defineAgent({ model })` uses the AI SDK execution path.

```ts
defineAgent({
  workspace: {
    mode: 'read',
    sources,
  },
  capabilities: [
    workspaceShell(),
  ],
  instructions: 'Use workspace sources.',
  model,
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
    workspaceShell(),
  ],
  instructions: async ({ fs }) => await fs.readFile('AGENTS.md'),
  model,
})
```

Use `workspaceShell()` for default read-only workspace shell inspection. Use `workspaceShell({ mode: 'write' })` only with `workspace.mode: 'write'`. Use inline or factory capabilities to expose raw tools:

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

`Message` comes from `@vite-hub/agent` and is re-exported by `@vite-hub/agent`.

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

## Agent evaluations

Agent evaluations use the Agent Definition's Runtime Config type. `@vite-hub/agent/eval` does not depend on `@vite-hub/env`; ViteHub Env is one optional producer of values passed through `runtimeConfig`.

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
  waitUntil?: (promise: Promise<unknown>) => void
  capabilities?: AgentCapabilities
  memo: <T>(key: string, factory: () => T | Promise<T>) => T | Promise<T>
}
```

Agent callbacks receive runtime host metadata, but not raw runtime config. Use `useServerEnv()` from `#vitehub/env/server` for app-owned Runtime Env values.

## Module options

```ts
interface AgentModuleOptions {
  devtools?: false
  route?: boolean | string
  runtime?: 'auto' | 'nitro' | 'vercel' | 'cloudflare-agents'
  execution?: 'inline' | 'workflow' | 'sandbox'
  imports?: boolean
  eval?: false | {
    cache?: boolean
    forceRerunTriggers?: string[]
    hideTable?: boolean
    maxConcurrency?: number
    scoreThreshold?: number
    server?: { port?: number }
    setupFiles?: string[]
    testTimeout?: number
    trialCount?: number
  }
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
