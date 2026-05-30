---
title: Custom capabilities
description: Build your own Agent ability with requirements, instructions, tools, policy, and metadata.
navigation.title: Custom capabilities
navigation.group: Capabilities
navigation.order: 28
icon: i-lucide-wrench
---

Create a custom Capability when the official catalog does not describe the ability your Agent needs.

Start from the product ability, not from the raw tool. A Capability should explain what the Agent can do, which requirements must exist, and how the model-facing surface is constrained.

## Minimal shape

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from '@vite-hub/agent'

export function tickets() {
  return defineCapability({
    id: 'tickets',
    instructions: {
      tickets: 'Use ticket tools only for support ticket lookup and triage.',
    },
    tools: {
      async searchTickets(input: { query: string }) {
        return searchTickets(input.query)
      },
    },
  })
}
```

Attach it to an Agent:

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { tickets } from './capabilities/tickets'

export default defineAgent({
  instructions: [
    'Triage support requests.',
    '{{ tickets }}',
  ].join('\n\n'),
  capabilities: [
    tickets(),
  ],
  model,
})
```

## Add requirements

Requirements fail early when the Agent does not have the primitive, workspace mode, path, or policy the Capability needs.

Use requirements to prevent accidental access. Do not create missing storage, workspace paths, or execution authority implicitly.

## Add policy

Model-facing actions need explicit policy.

Examples:

- Require approval before a write.
- Allow read-only inspection.
- Limit sandbox commands.
- Reject multi-statement SQL.
- Restrict a Workspace path prefix.

Policy should live with the Capability because that is where the model-facing action is exposed.

## Test and inspect

Use Agent Evals for repeatable behavior checks and DevTools for local inspection. A custom Capability should be inspectable enough that a developer can see:

- Which requirements passed.
- Which tools were exposed.
- Which instruction blocks were inserted.
- Which approvals or policy decisions happened.
- Which invocation context values were recorded.
