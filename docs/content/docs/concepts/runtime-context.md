---
title: Runtime Context
description: Understand the host resources passed into a server operation or Agent request.
navigation.order: 20
navigation.group: Runtime
icon: i-lucide-waypoints
---

Runtime Context contains the trusted host resources available to one ViteHub operation. It can include platform resources, request data, provider bindings, background work, memoized values, and trace information.

Invocation input describes the task. Runtime Context provides the host resources needed to run it.

## Runtime Context comes from the host

Framework and provider integrations create Runtime Context in the generated route or handler. A custom server call passes the same values itself because `runAgent()` does not read framework globals.

| Value | Used for |
| --- | --- |
| `runtime` and `platform` | Identifying the active runtime and platform. |
| `memo` | Resolve one value once during the current execution. |
| `waitUntil` and `flushWaitUntil` | Register background work and wait for it to finish. Host support controls work after the response. |
| Provider context | Reading trusted host resources such as bindings. |
| `trace` and `traceLog` | Keeping trace identity and recording structured events. |

Keep reusable behavior in Definitions and task data in invocation input. Runtime Context passes host resources to the operation.

## Adapt an H3 event

Use `getRuntimeContext()` in application-owned H3 or Nuxt routes. Create a new
context for each invocation:

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime/h3'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readBody<{ prompt: string }>(event)
  const runtime = getRuntimeContext(event, {
    runtimeConfig: useRuntimeConfig(event),
  })

  try {
    return await runAgent(support, runtime, { prompt })
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

The adapter accepts H3 1 and H3 2 events. It resolves Cloudflare bindings and the
host's `waitUntil` method from the supported event shapes. It preserves the
method's receiver and gives the invocation a fresh memo cache. Options can
supply `runtime`, `runtimeConfig`, `capabilities`, provider context, `request`,
`memo`, or `waitUntil` explicitly. Request data and provider resources stay in
Runtime Context, separate from invocation input.

The adapter reads bindings from the supplied event. It does not copy ambient
bindings into an unrelated request or change the active binding context.
Authenticate the caller and add trusted identity in the route before invoking
an Agent.

### Background work and cleanup

`waitUntil()` forwards work to the host lifetime API when one exists and tracks
that work for `flushWaitUntil()`. H3 2 can expose a `waitUntil()` method without a
backing host lifetime. The method's presence does not prove that work can survive
the response.

Without a real host lifetime, await `flushWaitUntil()` before returning. It waits
for tracked work, including work added by those tasks, then throws the first
observed failure. The example reports background failures without replacing the
Agent result or error. Decide how your host reports those failures.

Streaming handlers need a host lifetime that remains active while the stream is
consumed or cancelled. Calling `flushWaitUntil()` before returning a stream does
not cover work that the stream schedules later. The adapter does not cancel
background work, extend a serverless lifetime, or install process shutdown hooks.

### Adapt another host

Use `createRuntimeContext()` from `vite-hub/runtime` for a host-independent
constructor. Pass the runtime name and host resources explicitly:

```ts
import { createRuntimeContext } from 'vite-hub/runtime'

const runtime = createRuntimeContext({ runtime: 'unknown' })
runtime.waitUntil(Promise.resolve('background result'))
await runtime.flushWaitUntil()
```

This constructor supplies memo storage, tracked background work, and default
`capabilities` and `runtimeConfig` objects. `createExecutionContext()` remains the
normalizer for hosts that already supply their own memo and lifetime controls.

## Runtime Context is not a Capability

A Runtime Capability handle passes an implementation between packages. An Agent Capability gives an Agent a selected ability. It can use Runtime Context without exposing that context to the model.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. It shows which host supplies the runtime, background work, provider resources, and trace information.

Read [Runtime events](/docs/reference/runtime-events) for the records carried through Runtime Context and [Agent Invocations](/docs/concepts/agent-invocations) for the request record.
