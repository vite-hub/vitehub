---
title: Capabilities
description: Attach controlled abilities to an Agent without exposing raw server primitives by default.
navigation.title: Capabilities
navigation.group: Capabilities
navigation.order: 26
icon: i-lucide-blocks
---

Capabilities are user-shareable Agent abilities. They attach through `defineAgent({ capabilities })` and can contribute tools, instructions, policy, metadata, requirements, triggers, commands, and invocation context values.

Capabilities only belong in the Agent docs because they matter when a model-backed actor needs an ability.

## Capability vs server primitive

Server primitive:

```ts
import { kv } from '@vite-hub/kv'

await kv.set('settings', { theme: 'system' })
```

Agent Capability:

```ts
import { defineAgent } from '@vite-hub/agent'
import { kv } from '@vite-hub/agent/capabilities'

export default defineAgent({
  capabilities: [
    kv({ mode: 'read' }),
  ],
  instructions,
  model,
})
```

The primitive is app code authority. The Capability is model-facing authority.

## What a Capability can contribute

| Contribution | Meaning |
| --- | --- |
| Requirements | Primitive, workspace mode, path, or policy the Agent must satisfy before the Capability applies. |
| Instructions | Capability-owned guidance inserted through instruction slots. |
| Tools | Model-facing operations such as read, edit, query, execute, or search. |
| Policy | Approval and safety behavior for model-facing actions. |
| Metadata | Inspectable configuration details for runtime and DevTools. |
| Triggers | Product events that start Agent Invocations. |
| Context values | Typed invocation values that later callbacks can read. |

## Read next

- [Official capabilities](/docs/agents/capabilities/official-capabilities)
- [Custom capabilities](/docs/agents/capabilities/custom-capabilities)
