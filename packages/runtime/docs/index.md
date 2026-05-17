---
title: Runtime
description: Shared execution context, capability, policy, approval, and tracing primitives for ViteHub.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-route
frameworks: [vite, nitro]
---

`@vitehub/runtime` is the shared substrate below ViteHub primitives. It defines how packages pass host context, resolve capabilities, enforce policy, request approvals, attach traces, and coordinate leases.

Use Runtime when you are building or connecting primitives that need a portable execution context.

```ts
import { createExecutionContext, defineCapability, getCapability } from '@vitehub/runtime'

const context = createExecutionContext({
  capabilities: {
    queue: defineCapability('queue', queueClient),
  },
  memo,
  runtime: 'nitro',
  waitUntil,
})

const queue = getCapability<typeof context.runtime, typeof queueClient>(context, 'queue')
```

## What Runtime Owns

Runtime owns provider-neutral contracts:

| Contract | Purpose |
| --- | --- |
| `ExecutionContext` | Host runtime, request, waitUntil, memo, runtime config, and capabilities |
| `CapabilityHandle` | A typed handle for a primitive capability |
| `CapabilityPolicy` | Runtime-hard allow, deny, approval, and retry decisions |
| `ApprovalRequest` | First-class human approval state |
| `TraceContext` | Correlation data for runtime and primitive events |
| `Lease` | Thread, run, or resource ownership coordination |

## What Runtime Does Not Own

Runtime does not own chat adapters, model loops, durable workflow execution, sandbox sessions, or provider clients. Those stay in their primitive packages:

| Need | Use |
| --- | --- |
| Model and tool-loop execution | `@vitehub/agent` |
| Agent chat capability webhooks and threads | `@vitehub/agent` |
| Agent message state | `@vitehub/agent` |
| Durable orchestration | `@vitehub/workflow` |
| Isolated execution | `@vitehub/sandbox` |

## Architecture

Think in three layers:

1. Capabilities: database, KV, queue, workflow, sandbox, browser, email, analytics, auth.
2. Orchestrators: agent and workflow.
3. Interfaces: chat, HTTP routes, cron, queue consumers.

Runtime is only the contract layer that lets those packages meet without absorbing each other's responsibilities.
