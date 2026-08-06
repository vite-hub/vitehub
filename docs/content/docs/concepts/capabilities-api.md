---
title: Capabilities
description: "Understand how an Agent receives selected, inspectable abilities through Capabilities."
navigation.group: Core vocabulary
navigation.order: 12
icon: i-lucide-blocks
---

A Capability is a shareable bundle of Agent behavior. It can add tools, requirements, policy, trigger behavior, metadata, or invocation context to the Agent that attaches it.

Capabilities make model-facing access explicit. Installing KV or Workspace does not expose those primitives to every Agent; attaching a Capability chooses the ability for one Agent Definition.

## Capabilities compose an Agent

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { kv, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    workspaceShell({ mode: 'read' }),
    kv({ mode: 'read' }),
  ],
  driver: {
    run: ({ input }) => input,
  },
})
```

The Agent Driver sees only the abilities contributed by the resolved Capabilities. Application code can still call Server Primitives directly through Runtime Helpers.

## Static and invocation-resolved composition

Use an array when every invocation has the same Capabilities. Use a resolver when trusted invocation context decides which Capabilities apply.

```ts
capabilities: ({ actor }) => [
  customerRecords,
  ...(actor.meta?.support === true ? [internalDiagnostics] : []),
]
```

ViteHub resolves the Agent Invoker before it calls the resolver. The returned array is the complete composition for that request, and its order remains stable during execution.

## What a Capability does not do

A Capability does not give the model the full Runtime Context, unrestricted host access, or every installed primitive. Its requirements, tools, policy, and metadata define the access that the Agent can inspect and use.

Read the [Capabilities](/docs/capabilities) section for implementation details and [First agent](/docs/getting-started/first-agent) for a runnable Definition.
