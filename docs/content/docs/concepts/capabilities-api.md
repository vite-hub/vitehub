---
title: Capabilities
description: Understand how an Agent receives a selected ability.
navigation.order: 12
navigation.lanes: [agents]
icon: i-lucide-blocks
---

A Capability is a reusable bundle of Agent behavior. It can add tools, requirements, policy, trigger behavior, metadata, or invocation context to the Agent that selects it.

Installing a Server Primitive does not give every Agent access to it. Attach a Capability when the Agent should use that operation.

## Select the abilities an Agent can use

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { kv, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  workspace: { mode: 'read' },
  capabilities: [
    workspaceShell({ mode: 'read' }),
    kv({ mode: 'read' }),
  ],
  driver: {
    run: ({ input }) => input,
  },
})
```

The Agent Driver receives only what the selected Capabilities contribute. Application code can still call Server Primitives directly through their Runtime Helpers.

## Use a fixed or resolved list

Use an array when every invocation needs the same abilities. Use a resolver when trusted invocation data changes the list:

```ts
capabilities: ({ actor }) => [
  customerRecords,
  ...(actor.meta?.support === true ? [internalDiagnostics] : []),
],
```

ViteHub resolves the Agent Invoker before it calls the resolver. The returned array is the complete Capability list for that request.

## Keep access explicit

A Capability does not expose the full Runtime Context or unrestricted host access to the model. Its tools, requirements, policy, and metadata define what the Agent can inspect and use.

Read the [Capabilities](/docs/capabilities) section for implementation details and [First agent](/docs/getting-started/first-agent) for a runnable Definition.
