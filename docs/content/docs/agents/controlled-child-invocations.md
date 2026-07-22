---
title: Controlled child invocations
description: Start, inspect, and cancel a child Agent Invocation without assuming durable runtime support.
navigation.order: 23.5
icon: i-lucide-workflow
---

Use `startAgentInvocation()` when trusted parent or host code needs to control a child after starting it. The call returns after the selected runtime accepts the start and establishes the child Agent Invocation id.

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

Every start receives a fresh id. The id is stable for that logical invocation, but it does not promise that an inline or serverless runtime can resolve the child after the process ends. Workflow-backed children delegate inspection to their Workflow Run while the returned controller remains available; ViteHub does not add an invocation registry, persistence, or public lookup by id.

## Inspect lifecycle

`inspect()` returns either an available snapshot or an explicit unavailable outcome. Snapshots normalize the lifecycle to `pending`, `running`, `completed`, `failed`, or `cancelled`, and include terminal output or error only when the selected runtime owns it.

An unavailable outcome is not another lifecycle state. It means the selected runtime cannot currently resolve the invocation.

## Cancel active work

```ts
const cancellation = await child.cancel('The parent no longer needs this work.')

if (cancellation.outcome === 'accepted') {
  const latest = await child.inspect()
}
```

Inline cancellation propagates through a child-owned `AbortSignal`. Workflow-backed cancellation delegates to the selected Workflow provider. `accepted` means the cancellation request was accepted; inspect again for the observed terminal state. Providers can return `unsupported`, and completed or failed invocations return `invalid-state` instead of pretending they were cancelled.

## Discover input support

Follow-up and active steering are separate operations. Follow-up continues explicit context in a later invocation, while steering changes active work. Check both before sending input, and still handle the operation result because support can depend on lifecycle state.

```ts
if (child.support.steer) {
  const result = await child.sendInput({ prompt: 'Focus on the migration risk.' }, {
    mode: 'steer',
  })
}
```

Current built-in runtimes report follow-up and steering as `unsupported`; ViteHub does not reinterpret Harness session reuse or generic Workflow signals as Agent input. A runtime adapter must provide real ordering and lifecycle semantics before either support flag becomes true.

## Subagents

The `subagents()` Capability uses the same lower Agent Invocation start seam, but keeps its model-facing tool result serializable. Each tool call receives a fresh trusted child id and awaits the same compatibility result that `runAgent()` returned previously; the model cannot choose or reuse the child id.

Use `subagents()` for bounded model-selected delegation. Use `startAgentInvocation()` when trusted code needs the controller.
