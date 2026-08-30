---
title: Child invocations
description: Start, inspect, respond to, and cancel child Agent work from trusted code.
navigation.order: 51
navigation.group: Advanced execution
icon: i-lucide-workflow
---

Use `startAgentInvocation()` when trusted host or parent code must control child Agent work after starting it. A model-facing delegation tool can call the same trusted API, await `result`, and keep child selection in application code.

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

Every start gets a fresh stable id. `inspect()` returns an available snapshot or an explicit unavailable outcome. Available lifecycle states are `pending`, `running`, `completed`, `failed`, and `cancelled`.

When a Capability tool delegates work, pass its trusted `invoker` through the start options. The child then uses the same resolved identity and access scope as the parent. Do not accept this value from model tool input.

```ts
async function delegate(capabilityContext: AgentCapabilityContext) {
  return startAgentInvocation(researcher, runtimeContext, {
    prompt: 'Compare the two deployment options.',
  }, {
    invoker: capabilityContext.invoker,
  })
}
```

Await `child.result` when the caller needs the completed Agent result. This works for inline and Workflow-backed invocations. Application Capability tools must convert the result to a JSON-compatible value before returning delegated work to a model. Most Agent results can be returned directly, but web API objects such as `Response` need explicit conversion.

```ts
const result = await child.result

return result instanceof Response
  ? {
      body: await result.text(),
      contentType: result.headers.get('content-type'),
      status: result.status,
    }
  : result
```

Inline and serverless runtimes may become unavailable after their process ends. Workflow-backed children delegate inspection to their Workflow Run while the returned controller remains available. ViteHub does not add a separate invocation registry or public lookup by id.

## Cancel active work

```ts
const cancellation = await child.cancel('The parent no longer needs this work.')

if (cancellation.outcome === 'accepted') {
  const latest = await child.inspect()
}
```

`accepted` means the runtime accepted the request; inspect again for the observed terminal state. A provider may return `unsupported`, and terminal invocations return `invalid-state`.

## Respond to provider requests

Check the controller's current support before sending input, then handle the operation result because support can change with lifecycle state.

```ts
if (child.support.respond) {
  const result = await child.sendInput(
    { messages: [responseMessage] },
    { mode: 'respond' },
  )
}
```

Inline provider runtimes accept approval decisions and `data-agent-input` answers while the matching provider request is pending. Text steering, follow-up turns, and Workflow-backed input remain unsupported until their runtime adapters provide equivalent ordering and lifecycle semantics.

Keep child Agent selection outside model input. The model can choose a named application tool, while trusted code supplies the Agent Definition and ViteHub assigns the child id.
