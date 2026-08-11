---
title: Child invocations
description: Start, inspect, steer, and cancel child Agent work from trusted code.
navigation.order: 51
navigation.group: Advanced execution
icon: i-lucide-workflow
---

Use `startAgentInvocation()` when trusted host or parent code must control child Agent work after starting it. Use the [Subagents Capability](/docs/capabilities/subagents) when the active model should choose and await delegation itself.

## Start and inspect a child

```ts
import { startAgentInvocation } from '@vite-hub/agent'
import researcher from '../agents/researcher'

const child = await startAgentInvocation(researcher, runtimeContext, {
  prompt: 'Compare the two deployment options.',
})

const current = await child.inspect()
if (current.outcome === 'available') {
  console.log(current.invocation.id, current.invocation.status)
}
```

Every start gets a fresh stable id. `inspect()` returns an available snapshot or an explicit unavailable outcome. Available lifecycle states are `pending`, `running`, `completed`, `failed`, and `cancelled`.

Inline and serverless runtimes may become unavailable after their process ends. Workflow-backed children delegate inspection to their Workflow Run while the returned controller remains available. ViteHub does not add a separate invocation registry or public lookup by id.

## Cancel active work

```ts
const cancellation = await child.cancel('The parent no longer needs this work.')

if (cancellation.outcome === 'accepted') {
  const latest = await child.inspect()
}
```

`accepted` means the runtime accepted the request; inspect again for the observed terminal state. A provider may return `unsupported`, and terminal invocations return `invalid-state`.

## Steer when supported

Check the controller's current support before sending input, then handle the operation result because support can change with lifecycle state.

```ts
if (child.support.steer) {
  const result = await child.sendInput(
    { prompt: 'Focus on migration risk.' },
    { mode: 'steer' },
  )
}
```

Inline harness runtimes can report steering while an active prompt controller is available. Follow-up and Workflow-backed input remain unsupported until their runtime adapters provide equivalent ordering and lifecycle semantics.

The `subagents()` Capability uses the same start seam but returns a serializable tool result and waits for the child. The model cannot choose or reuse the trusted child id.
