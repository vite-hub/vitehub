---
title: Child invocations
description: Start, inspect, respond to, and cancel child Agent work from trusted code.
navigation.order: 80
navigation.group: Advanced execution
icon: i-lucide-workflow
---

`startAgentInvocation()` starts an Agent and returns a controller. Trusted
code uses the controller to inspect the child, cancel it, or send it input
while it runs. Use it when a parent Agent, a Capability tool, or host code must
control child work after it starts.

Use [`runAgent()`](/docs/agents/invocations) when you only need the result.
`runAgent()` follows the configured runtime: an inline runtime returns the
Agent output, and a Workflow runtime returns a Workflow Run. The controller
from `startAgentInvocation()` does not return a final result that you can
await. It gives control and inspection.

## Start and inspect a child

```ts
import { startAgentInvocation } from 'vite-hub/agent'
import researcher from '../agents/researcher'

const child = await startAgentInvocation(researcher, runtimeContext, {
  prompt: 'Compare the two deployment options.',
})

const current = await child.inspect()
if (current.outcome === 'available') {
  console.log(current.invocation.id, current.invocation.status)
}
```

Each start gets a new, stable `child.id`. `inspect()` returns an `available`
snapshot or an explicit `unavailable` outcome. An available snapshot has one of
these states: `pending`, `running`, `completed`, `failed`, or `cancelled`.

An inline or serverless runtime can become unavailable after its process ends.
A Workflow-backed child forwards inspection to its Workflow Run while you keep
the controller. ViteHub does not keep a registry of controllers, and you
cannot look one up by id later.

## Cancel active work

```ts
const cancellation = await child.cancel('The parent no longer needs this work.')

if (cancellation.outcome === 'accepted') {
  const latest = await child.inspect()
}
```

`accepted` means that the runtime accepted the request. Inspect again to see
the terminal state. A provider can return `unsupported`. A child that already
finished returns `invalid-state`.

## Respond to provider requests

Check `child.support` before you send input. Then check the result, because
support can change with the lifecycle state.

```ts
if (child.support.respond) {
  const result = await child.sendInput(
    { messages: [responseMessage] },
    { mode: 'respond' },
  )
}
```

| Mode | Use it to | Support |
| --- | --- | --- |
| `'respond'` | Answer a pending provider approval or a `data-agent-input` question. | Inline provider runtimes, while the matching request is pending. |
| `'steer'` | Add text to the active provider turn. The prompt can be a string or a text-only `Message[]`. | When `child.support.steer` is `true`. |
| `'follow-up'` | Start another turn. | Not supported yet. |

Steering returns `accepted` when the provider adds the input to the active
turn. It returns `unsupported` when the provider cannot do this safely, for
example for input with attachments. An unclear submission or cancellation
failure returns `invalid-state`. Do not send that input again automatically.

Workflow-backed children do not accept input yet. Their runtime adapters do
not give the same order and lifecycle guarantees.

## Keep child selection in trusted code

The model can call a named application tool. Trusted code selects the Agent
Definition, and ViteHub assigns the child id. Do not let model input choose
which Agent runs.

When a tool uses `runAgent()` instead, handle its runtime-specific return
value. Do not assume that every runtime returns a completed result.

## Hand off input resources

A host integration that allocates input resources, such as uploaded files, can
pass `onInputHandoff` in the fourth argument:

```ts
const child = await startAgentInvocation(researcher, runtimeContext, input, {
  onInputHandoff() {
    markUploadsAsOwnedByRuntime()
  },
})
```

This synchronous callback runs immediately before input can reach the inline
runtime or the Workflow provider.

- If the start fails before the callback, the host can remove its new input
  resources.
- After the callback, the runtime can keep the input even if the start fails.
  Keep those resources until you know who owns them.

The callback does not confirm durable acceptance. It does not replace cleanup
after a process interruption.
