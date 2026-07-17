---
title: Runtime Context
description: Understand the host-owned execution facts ViteHub passes across server primitives and Agent Invocations.
navigation.order: 12
icon: i-lucide-waypoints
---

Runtime Context carries host-owned execution facts into a ViteHub operation. It tells packages where work runs and how to memoize values, register background work, access host resources, and continue traces without depending on framework globals.

The caller or host integration owns Runtime Context. Invocation input carries task data, while Runtime Context carries execution mechanisms and trusted host resources, which keeps the ownership boundary inspectable.

## What Runtime Context contains

The shared `RuntimeHostContext` defines the cross-package shape. Feature packages can narrow or extend it for their own runtime boundary, such as the Agent Package's `AgentRuntimeContext`.

| Field or family | Owner | Purpose |
| --- | --- | --- |
| `runtime` and `platform` | Host integration | Identify the active runtime and platform when package behavior depends on them. |
| `memo` | Caller or host integration | Resolve one value once within the current execution boundary. |
| `waitUntil` and `flushWaitUntil` | Host integration or local runner | Register work that can continue after the immediate handler returns, then drain it when a local runtime must wait. |
| `runtimeConfig` | Application or package integration | Carry trusted runtime configuration that has already crossed the host boundary. |
| `request` and `event` | Host integration | Expose the current transport object when a package needs request-specific host behavior. |
| Provider context | Provider integration | Carry provider-owned resources such as Cloudflare bindings or Vercel wait-until support. |
| Runtime Capability handles | Package integration | Pass resolved primitive or provider implementations between ViteHub packages. |
| `trace` and `traceLog` | Caller or runtime | Preserve trace identity and record structured runtime behavior across package boundaries. |

Runtime Context should contain execution facts and trusted host resources. Put portable behavior in Definitions, task data in invocation input, and deployment artifacts in Provider Output.

## Keep the boundaries separate

| Surface | What it owns |
| --- | --- |
| Runtime Context | Host execution facts, request-scoped resources, background-work support, and trace continuity. |
| Runtime Helper | The stable application API used to call or inspect a ViteHub primitive. |
| Agent Invocation input | Prompt or message content, application context, call options, cancellation, and timeout for one invocation. |
| Definition Options | Portable configuration that travels with one Definition. |
| Provider Output | Generated host artifacts such as routes, functions, bindings, workers, and crons. |

Runtime Capability handles and Agent Capabilities also solve different problems. A Runtime Capability handle carries a resolved implementation between packages, while an Agent Capability grants selected model-facing abilities to one Agent Definition. An Agent Capability can consume a Runtime Capability handle without exposing the Runtime Context itself to the model.

## Pass context from a custom host

Framework and provider integrations construct Runtime Context at generated host boundaries. A custom route or server passes the equivalent values explicitly because `runAgent()` does not read framework globals.

```ts [server/api/support.post.ts]
import { runAgent } from 'vite-hub/agent'
import support from '../agents/support'

export async function handleSupportRequest(prompt: string) {
  const memo = new Map<string, unknown>()

  return runAgent(support, {
    memo<T>(key: string, create: () => T): T {
      if (!memo.has(key)) memo.set(key, create())
      return memo.get(key) as T
    },
    runtime: 'vite',
    waitUntil: task => { void task.catch(error => console.error(error)) },
  }, {
    prompt,
  })
}
```

The second argument is Runtime Context. The third argument is Agent Invocation input, and the memo state lasts only for this request.

## Inspect the handoff

Inspect the generated route or custom server call that starts the operation. The runtime argument should show which host owns `runtime`, `memo`, `waitUntil`, provider resources, and trace continuity, while the Definition and invocation input remain host-independent.

## Next steps

- Read [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) for the application-facing API boundary.
- Read [Agent Invocations](/docs/agents/invocations) for the input and lifecycle boundary.
- Read [Runtime events](/docs/reference/runtime-events) for trace, policy, approval, and lifecycle records.
