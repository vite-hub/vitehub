---
title: ViteHub Runtime
description: Shared contracts across ViteHub packages, including Runtime Context, Capabilities, policy, traces, errors, leases, and host bindings.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-cpu
---

`@vite-hub/runtime` holds the contracts that every ViteHub package shares. A contract is a TypeScript type and a small set of functions that two packages agree on. Runtime owns these contracts:

- Runtime Context carries host resources for one request or job, such as bindings and background work.
- Runtime Capabilities pass named implementations from one package to another.
- Policy Decisions, approvals, and Trace Events.
- The error contract: `Result`, `ResultError`, and `defineErrors()`.
- Leases, host bindings, and execution authority.

Runtime does not register Vite, Nuxt, routes, providers, or Agent Definitions. Feature packages handle those layers and build on Runtime underneath.

## Choose an import

| You are building | Install | Import |
| --- | --- | --- |
| A ViteHub application | `vite-hub` | `vite-hub/runtime` |
| A reusable package or a custom host integration | `@vite-hub/runtime` | `@vite-hub/runtime` |

Import `vite-hub/runtime` when `vite-hub` is already in your app. Install `@vite-hub/runtime` directly when a library needs only the portable contracts. It needs Node.js 22.22 or newer.

```bash pm
pnpm add @vite-hub/runtime
```

## Get a first result

Create a Runtime Context, register one Runtime Capability, and read it back:

```ts [scripts/health.ts]
import { createRuntimeContext, defineCapability, getCapability } from '@vite-hub/runtime'

const context = createRuntimeContext({
  capabilities: {
    health: defineCapability('health', { status: 'ready' }),
  },
  runtime: 'node',
})

const health = getCapability(context, 'health')
console.log(`${context.runtime}:${health.kind}`)
await context.flushWaitUntil()
```

Running the script prints:

```txt [Output]
node:health
```

- `createRuntimeContext()` adds memo storage and tracks background work. The host still gives the runtime name, request, and bindings.
- `getCapability()` reads only own properties on `context.capabilities`.
- `flushWaitUntil()` awaits all background work tracked on the context.

## Know what Runtime does not do

Runtime does not discover framework globals, keep an ambient context, or isolate requests from one another. It does not clone, redact, or encrypt values on a context. Code that receives a context can read every value on it. Pass only the bindings and secrets the operation needs.

## Read next

::card-group
:::card{title="Runtime Helpers" icon="i-lucide-code-2" to="/docs/runtime/helpers"}
Find the server import path for each feature and fix import errors.
:::

:::card{title="Runtime Context" icon="i-lucide-waypoints" to="/docs/runtime/context"}
Pass host resources from a route to an Agent or server operation.
:::

:::card{title="Runtime events" icon="i-lucide-activity" to="/docs/runtime/events"}
Inspect Trace Event, policy, approval, stream, and usage records.
:::

:::card{title="Errors" icon="i-lucide-circle-alert" to="/docs/runtime/errors"}
Return `[error, data]` tuples and define a catalog of error codes.
:::

:::card{title="Server API" icon="i-lucide-square-function" to="/docs/runtime/server-api"}
Use host bindings, Capabilities, policy, traces, leases, and shutdown.
:::
::
