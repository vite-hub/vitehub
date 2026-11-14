---
title: Runtime Context
navigation.title: Runtime Context
description: The host resources that ViteHub passes to a server operation or Agent request.
navigation.order: 55.1
navigation.group: Runtime and output
icon: i-lucide-waypoints
---

Invocation input says what to do. Runtime Context gives the trusted host resources to do it: request data, provider bindings, background work, memoized values, and trace data.

## Runtime Context comes from the host

Framework and provider integrations create Runtime Context in the generated route or handler. A custom server call passes the same values itself as the `runtimeContext` option of `runAgent()` and `streamAgent()`, because they do not read framework globals.

| Value | Used for |
| --- | --- |
| `runtime` and `platform` | The active runtime and platform. |
| `memo` | Compute a value once per execution. `runAgent()`, `streamAgent()`, and `startAgentInvocation()` create a new cache when the context has none. |
| `waitUntil` and `flushWaitUntil` | Add background work and wait for it. The host decides if work runs after the response. |
| Provider context | Trusted host resources such as bindings. |
| `trace` and `traceLog` | Trace identity and structured events. |

Reusable behavior belongs in Definitions, not here.

## Adapt a Fetchable handler

A [Fetchable](https://fetchable.org) handler is a module that exports
`fetch(request)` and returns a `Response`. Nitro, Vite deployment plugins, and
most server runtimes call this shape. Pass its `Request` to `getRuntimeContext()`
from `vite-hub/runtime`. This example uses the app's `server/agents/support.ts`
Agent Definition:

```ts [server/routes/api/support.post.ts] fragment
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime'
import support from '../../agents/support'

export default {
  async fetch(request: Request) {
    const { prompt } = await request.json()
    const runtime = getRuntimeContext(request)

    try {
      const [error, result] = await runAgent(support, { prompt }, { runtimeContext: runtime })
      if (error) throw error
      return Response.json({ text: result.text })
    }
    finally {
      await runtime.flushWaitUntil().catch(console.error)
    }
  },
}
```

The function reads the host data that srvx and Nitro put on the `Request`:
`runtime.cloudflare.env`, `runtime.cloudflare.context`, `waitUntil`, and `ip`.
It accepts the same options as the H3 adapter. `getStandardContext(request)` returns
the [Standard Context](#standard-context) of the `Request`, so you can pass the
`Request` to ViteHub APIs that take a request event.

In a ViteHub app, Nitro sets the Standard Context of the H3 event on its
`Request` too. H3 then adds the response headers that primitives set, such as
`requireRateLimit()` headers, to the `Response` that the handler returns. Outside
Nitro, nothing reads `res`. Copy `res.status` and `res.headers` to your `Response`
when you use a primitive that sets them.

## Adapt an H3 event

Use `getRuntimeContext()` in application-owned H3 or Nuxt routes with Nitro 3.
Create a new context for each invocation:

The route runs this Agent:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  driver: {
    model: 'openai/gpt-5.1-mini',
    instructions: 'Answer support questions. Say when you need more information.',
  },
})
```

```ts [server/api/support.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import * as v from 'valibot'
import { runAgent } from 'vite-hub/agent'
import { getRuntimeContext } from 'vite-hub/runtime'
import support from '../agents/support'

export default defineEventHandler(async (event) => {
  const { prompt } = await readValidatedBody(event, v.parser(v.object({ prompt: v.string() })))
  const runtime = getRuntimeContext(event, {
    runtimeConfig: useRuntimeConfig(),
  })

  try {
    const [error, result] = await runAgent(support, { prompt }, { runtimeContext: runtime })
    if (error) throw error
    return { text: result.text }
  }
  finally {
    await runtime.flushWaitUntil().catch(console.error)
  }
})
```

The adapter accepts any event with [Standard Context](#standard-context), which includes H3 2 events in a ViteHub app. It reads the request, Cloudflare bindings, and the host's `waitUntil` from `event["~standard"]`, and gives the invocation a new memo cache.

- Options can set `runtime`, `runtimeConfig`, `capabilities`, provider context, `request`, `memo`, or `waitUntil`.
- Request data and provider resources stay in Runtime Context, not in invocation input.
- An event without a request throws `RUNTIME_R0015`.
- Bindings come only from this event. The adapter does not copy bindings from another request or change the active binding context.

Authenticate the caller and add a trusted identity in the route before you call an Agent.

### Standard Context

ViteHub reads request events through [Standard Context](https://github.com/standard-servers/standard-context), a proposed shared type for server framework events. Such an event has a `~standard` object:

| Property | Value |
| --- | --- |
| `vendor` | The framework name, such as `h3`. |
| `req` | The incoming Web `Request`. |
| `res` | The `status` and `headers` of the response. |
| `runtime` | `cloudflare.env`, `cloudflare.context`, and `clientAddress` when the host provides them. |
| `waitUntil` | The host lifetime method, if the host has one. |

H3 does not set `~standard` yet, so a ViteHub Nitro `request` hook sets it on each H3 2 event and adds it to the `H3Event` type. A value that the host sets stays.

- Each property is computed on first read and kept for the request. A route that never reads `~standard` does no extra work.
- H3 sends the handler's return value as the body, so setting `res.body` throws `RUNTIME_R0016`.

```ts [server/api/whoami.get.ts]
import { defineEventHandler } from 'h3'

export default defineEventHandler((event) => {
  const { req, runtime } = event['~standard']
  return { path: new URL(req.url).pathname, client: runtime?.clientAddress }
})
```

`getStandardContext(event)` from `vite-hub/runtime` returns `event["~standard"]`.
It also accepts a `Request`. A value that is neither throws `RUNTIME_R0015`.
ViteHub primitives such as `requireRateLimit()` and `useServerEnv()` set
`~standard` themselves when it is missing, such as for an event in a test. The
`ViteHubContext` type comes from `vite-hub/runtime` and does not load H3 types. In
a ViteHub app, the generated `.vitehub/types.d.ts` adds `~standard` to `H3Event`.

### Background work and cleanup

The H3 adapter uses `options.waitUntil` first, then `options.vercel.waitUntil`, then the event lifetime. It binds each function to its own object.

`waitUntil()` passes work to the host lifetime API, if there is one, and tracks it for `flushWaitUntil()`.

::warning
H3 2 can have a `waitUntil()` method with no real host lifetime behind it. The method alone does not prove that work survives the response.
::

Without a real host lifetime, await `flushWaitUntil()` before you return. It waits for tracked work and any work it adds, then throws the first failure. The example logs those failures and keeps the Agent result. Choose how your host reports them.

A streaming handler needs a host lifetime that lasts until the stream is read or cancelled. `flushWaitUntil()` does not cover work that the stream adds later. The adapter does not cancel background work, extend a serverless lifetime, or add shutdown hooks.

### Adapt another host

For any other host, use `createRuntimeContext()` from `vite-hub/runtime`. Pass the runtime name and host resources:

```ts
import { createRuntimeContext } from 'vite-hub/runtime'

const runtime = createRuntimeContext({ runtime: 'unknown' })
runtime.waitUntil(Promise.resolve('background result'))
await runtime.flushWaitUntil()
```

It gives memo storage, tracked background work, and default `capabilities` and `runtimeConfig` objects. Use `createExecutionContext()` for hosts that already have their own memo and lifetime controls.

## Runtime Context is not a Capability

A Runtime Capability handle passes an implementation between packages. An Agent Capability gives an Agent one ability. It can use Runtime Context without showing it to the model.

## Inspect the handoff

The generated route or custom server call that starts the operation shows where the runtime, background work, provider resources, and trace data come from.

See [Runtime events](/docs/reference/runtime-events) for the records in Runtime Context and [Agent Invocations](/docs/agents/invocations) for the request record.
