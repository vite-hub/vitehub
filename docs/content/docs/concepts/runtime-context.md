---
title: Runtime Context
description: Understand the host resources passed into a server operation or Agent request.
navigation.order: 20
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
| `waitUntil` | Continue background work after the handler returns. |
| Provider context | Reading trusted host resources such as bindings. |
| `trace` and `traceLog` | Keeping trace identity and recording structured events. |

Keep reusable behavior in Definitions and task data in invocation input. Runtime Context passes host resources to the operation.

## Adapt an H3 event

Application-owned routes need one host adapter for the Runtime Context used by
the Agent examples:

```ts [server/runtime-context.ts]
import type { AgentRuntimeName, AgentWaitUntil } from 'vite-hub/agent'
import type { H3Event } from 'h3'

function waitUntilFrom(value: unknown): AgentWaitUntil | undefined {
  const owner = value as { waitUntil?: AgentWaitUntil } | undefined
  return typeof owner?.waitUntil === 'function'
    ? owner.waitUntil.bind(value)
    : undefined
}

function waitUntilFor(event: H3Event): AgentWaitUntil {
  const context = event.context as {
    cloudflare?: { context?: unknown }
    _platform?: { cloudflare?: { context?: unknown } }
  }
  const node = event.node as {
    req?: { runtime?: { cloudflare?: { context?: unknown } } }
  }
  const req = event.req as {
    runtime?: { cloudflare?: { context?: unknown } }
  }

  return waitUntilFrom(event)
    ?? waitUntilFrom(context)
    ?? waitUntilFrom(context.cloudflare?.context)
    ?? waitUntilFrom(context._platform?.cloudflare?.context)
    ?? waitUntilFrom(req?.runtime?.cloudflare?.context)
    ?? waitUntilFrom(node?.req?.runtime?.cloudflare?.context)
    ?? (task => { void Promise.resolve(task).catch(error => console.error(error)) })
}

function cloudflareFor(event: H3Event) {
  const runtimeEvent = event as H3Event & {
    env?: Record<string, unknown>
    context: H3Event['context'] & {
      cloudflare?: { context?: unknown, env?: Record<string, unknown> }
      _platform?: { cloudflare?: { context?: unknown, env?: Record<string, unknown> } }
    }
    req?: { runtime?: { cloudflare?: { context?: unknown, env?: Record<string, unknown> } } }
    node?: { req?: { runtime?: { cloudflare?: { context?: unknown, env?: Record<string, unknown> } } } }
  }
  const env = runtimeEvent.env
    ?? runtimeEvent.context.cloudflare?.env
    ?? runtimeEvent.context._platform?.cloudflare?.env
    ?? runtimeEvent.req?.runtime?.cloudflare?.env
    ?? runtimeEvent.node?.req?.runtime?.cloudflare?.env
  const context = runtimeEvent.context.cloudflare?.context
    ?? runtimeEvent.context._platform?.cloudflare?.context
    ?? runtimeEvent.req?.runtime?.cloudflare?.context
    ?? runtimeEvent.node?.req?.runtime?.cloudflare?.context

  return env ? { env, ...(context ? { context } : {}) } : undefined
}

function runtimeFor(event: H3Event): AgentRuntimeName {
  const env = typeof process === 'object' && process ? process.env : undefined

  if (cloudflareFor(event)) return 'cloudflare-agents'
  if ('Deno' in globalThis) return 'deno'
  if (env?.VERCEL) return 'vercel'
  return env?.NODE_ENV === 'development' ? 'vite' : 'unknown'
}

export function getRuntimeContext(event: H3Event) {
  const cloudflare = cloudflareFor(event)
  const values = new Map<string, unknown>()

  return {
    ...(cloudflare ? { cloudflare } : {}),
    memo<T>(key: string, create: () => T): T {
      if (!values.has(key)) values.set(key, create())
      return values.get(key) as T
    },
    runtime: runtimeFor(event),
    waitUntil: waitUntilFor(event),
  }
}
```

Keep this adapter host-owned. Add provider resources here and delegate
`waitUntil` to the real host lifetime when one exists. The fallback observes
failures for long-lived local Node processes; serverless deployments must
expose their provider lifetime adapter through the event context.

## Runtime Context is not a Capability

A Runtime Capability handle passes an implementation between packages. An Agent Capability gives an Agent a selected ability. It can use Runtime Context without exposing that context to the model.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. It shows which host supplies the runtime, background work, provider resources, and trace information.

Read [Runtime events](/docs/reference/runtime-events) for the records carried through Runtime Context and [Agent Invocations](/docs/concepts/agent-invocations) for the request record.
