---
title: ViteHub Runtime
description: The shared contracts of ViteHub packages, such as Runtime Context, Capabilities, policy, traces, errors, leases, and host bindings.
navigation.title: Overview
navigation.order: 1
navigation.group: Start
icon: i-lucide-cpu
---

`@vite-hub/runtime` holds the contracts that every ViteHub package shares. A contract is a type and a small set of functions that two packages agree on. Runtime owns these contracts:

- Runtime Context: the host resources of one request or job, such as bindings and background work.
- Runtime Capabilities: named implementations that one package passes to another.
- Policy Decisions, approvals, and Trace Events.
- The error contract: `Result`, `ResultError`, and `defineErrors()`.
- Leases, host bindings, and execution authority.

Runtime does not register Vite, Nuxt, routes, providers, or Agent Definitions. Other packages do that and use Runtime underneath.

## Choose an import

| You are building | Install | Import |
| --- | --- | --- |
| A ViteHub application | `vite-hub` | `vite-hub/runtime` |
| A reusable package or a custom host integration | `@vite-hub/runtime` | `@vite-hub/runtime` |
| Node diagnostics and process lifecycle | The same package | `vite-hub/runtime/node` or `@vite-hub/runtime/node` |
| An H3 or Nuxt route | `vite-hub` | `vite-hub/runtime/h3` |

Use `vite-hub/runtime` when `vite-hub` is already a dependency of your app. Install `@vite-hub/runtime` alone when a library must depend only on the portable contracts. It needs Node.js 22.18 or newer.

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

Running the file prints:

```txt [Output]
node:health
```

- `createRuntimeContext()` adds memo storage and tracks background work. The host still gives the runtime name, the request, and the bindings.
- `getCapability()` reads only own properties of `context.capabilities`.
- `flushWaitUntil()` waits for the background work that the context tracks.

## Know what Runtime does not do

Runtime does not discover framework globals, keep an ambient context, or isolate requests from each other. It does not clone, redact, or encrypt the values on a context. Code that gets a context can read every value on it. Pass only the bindings and secrets that the operation needs.

## Read next

::card-group
:::card{title="Runtime Helpers" icon="i-lucide-code-2" to="/docs/runtime/helpers"}
Find the server import of each feature and fix import failures.
:::

:::card{title="Runtime Context" icon="i-lucide-waypoints" to="/docs/runtime/context"}
Pass host resources from a route to an Agent or a server operation.
:::

:::card{title="Runtime events" icon="i-lucide-activity" to="/docs/runtime/events"}
Read the Trace Event, policy, approval, stream, and usage records.
:::

:::card{title="Errors" icon="i-lucide-circle-alert" to="/docs/runtime/errors"}
Return `[error, data]` results and define a catalog of error codes.
:::

:::card{title="Server API" icon="i-lucide-square-function" to="/docs/runtime/server-api"}
Use host bindings, Capabilities, policy, traces, leases, and shutdown.
:::
::
