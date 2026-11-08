---
title: Child invocations
description: Start, inspect, respond to, and cancel child Agent work from trusted code.
navigation.order: 74
navigation.group: Advanced
icon: i-lucide-workflow
navigation.kind: Guides
---

`startAgentInvocation()` starts a child Agent and returns a controller. With
it, trusted code (a parent Agent, a Capability tool, or host code) can inspect
the child, cancel it, or send it input while it runs. The controller gives no
final result to await.

If you only need the result, use [`runAgent()`](/docs/agents/invocations). An
inline runtime returns the Agent output, and a Workflow runtime returns a
Workflow Run.

## Start and inspect a child

```ts fragment
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
snapshot with state `pending`, `running`, `completed`, `failed`, or
`cancelled`, or an explicit `unavailable` outcome.

An inline or serverless child can become unavailable after its process ends.
A Workflow-backed child reads from its Workflow Run while you keep the
controller. ViteHub keeps no controller registry, so you cannot look one up
by id later.

## Cancel active work

```ts fragment
const cancellation = await child.cancel('The parent no longer needs this work.')

if (cancellation.outcome === 'accepted') {
  const latest = await child.inspect()
}
```

`accepted` means the runtime took the request. Inspect again to see the end
state. A provider can return `unsupported`. A finished child returns
`invalid-state`.

## Respond to provider requests

Check `child.support` before you send input. Check the result too, because
support changes with the lifecycle state.

```ts fragment
if (child.support.respond) {
  const result = await child.sendInput(
    { messages: [responseMessage] },
    { mode: 'respond' },
  )
}
```

| Mode | Use it to | Support |
| --- | --- | --- |
| `'respond'` | Answer a pending provider approval or a `data-agent-input` question. | Inline provider runtimes, while the request is pending. |
| `'steer'` | Add text to the active provider turn, as a string or a text-only `Message[]`. | When `child.support.steer` is `true`. |
| `'follow-up'` | Start another turn. | Not supported yet. |

Steering returns:

- `accepted` when the provider adds the input to the active turn.
- `unsupported` when the provider cannot do it safely, for example for input with attachments.
- `invalid-state` for an unclear submission or a cancel failure. Do not resend that input automatically.

Workflow-backed children do not accept input yet, because their adapters lack
the same order and lifecycle guarantees.

## Keep child selection in trusted code

The model can call a named app tool. Trusted code picks the Agent Definition,
and ViteHub gives the child id. Do not let model input choose which Agent runs.

If a tool uses `runAgent()`, handle its runtime-specific return value. Not
every runtime returns a completed result.

## Hand off input resources

If your host creates input resources, such as uploaded files, pass
`onInputHandoff` in the fourth argument:

```ts fragment
const child = await startAgentInvocation(researcher, runtimeContext, input, {
  onInputHandoff() {
    markUploadsAsOwnedByRuntime()
  },
})
```

This synchronous callback runs just before input can reach the inline runtime
or the Workflow provider.

- If the start fails before the callback, the host can remove the new resources.
- After the callback, the runtime can keep the input even if the start fails.
  Keep the resources until you know who owns them.

The callback does not confirm durable acceptance or replace cleanup after a
process interruption.
