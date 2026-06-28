---
title: Custom capabilities
description: Build one product-specific Agent ability with requirements, tools, policy, and metadata.
navigation.title: Custom capabilities
navigation.order: 3
navigation.group: Start here
icon: i-lucide-wrench
---

Create a custom Capability when the official catalog does not describe the Agent ability your product needs.
Start from the product ability, not from the raw tool or primitive call.

A useful custom Capability names what the Agent can do, declares the requirements that must exist, and keeps the model-facing surface constrained.
It should be inspectable enough that a developer can see which tools, triggers, context values, metadata, and policy decisions came from that one Capability.

## Minimum shape

Define the Capability near the product boundary that owns the behavior.
Use `defineCapability()` so ViteHub validates the id and composes the Capability through the normal lifecycle.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from '@vite-hub/agent'

export function tickets() {
  return defineCapability({
    id: 'tickets',
    tools: {
      searchTickets: {
        name: 'searchTickets',
        description: 'Search support tickets by query.',
        execute: async (input: { query: string }) => searchTickets(input.query),
      },
    },
  })
}
```

Attach the custom Capability like any official Capability.
Keep instructions explicit in the Agent Driver so Capability config does not become a hidden prompt bag.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { tickets } from './capabilities/tickets'

export default defineAgent({
  driver: {
    model,
    instructions: [
      'Triage support requests.',
      'Use ticket tools only for support ticket lookup and triage.',
    ].join('\n\n'),
  },
  capabilities: [
    tickets(),
  ],
})
```

## Add requirements

Requirements fail before the Capability exposes behavior.
Use them when the Capability needs a configured primitive, a Workspace, a writable Workspace, or a specific Workspace path.

Do not create missing storage, Workspace paths, or execution authority implicitly.
If the product needs provisioning, keep that in the primitive or framework integration layer.

## Add policy

Policy belongs with the model-facing action.
Use it to require approval for writes, limit shell or sandbox commands, restrict prefixes, reject unsafe SQL, or prevent broad Workspace access.

Custom policy should be narrow and visible.
A reviewer should be able to understand the Capability's authority by reading the Capability Definition.

## Contribute Workspace inputs

Use `workspace` when a Capability should add invocation-scoped Workspace Sources or rules.
The contribution is add-only and inspectable; it does not mutate the Agent's authored Workspace Definition.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from '@vite-hub/agent'

export function ticketContext() {
  return defineCapability({
    id: 'ticket-context',
    workspace: ({ context }) => {
      const ticketId = context.get<{ id?: string }>('ticket')?.id
      if (!ticketId) return

      return {
        rules: {
          'support/tickets/**': { read: true },
        },
        sources: {
          ticket: {
            mount: 'support/tickets',
            async getKeys() {
              return [`${ticketId}.md`]
            },
            async getItem(key) {
              return {
                content: await loadTicketMarkdown(key),
                key,
                mediaType: 'text/markdown',
              }
            },
          },
        },
      }
    },
  })
}
```

Use `harnessWorkspacePaths` when a harness-backed Agent needs specific contributed paths materialized into the harness Workspace Session.

## Driver support

| Agent Driver | Custom Capability behavior |
| --- | --- |
| Model-backed | Receives model-facing tools when the Capability contributes them. |
| Harness-backed | Receives only runtime effects and explicitly supported harness-compatible contributions. |
| Custom-run-backed | Receives prepared input and invocation context; `driver.run` decides which custom Capability outputs to consume. |

## Inspect and verify

Run one Agent Invocation and inspect the Agent in DevTools.
Check that the custom Capability id appears once, its requirements pass, and its tools are exposed only when expected.

Add an Agent Eval when the Capability changes product behavior.
Use a focused fixture that proves the Capability exposes the intended ability and does not expose adjacent authority.

## Expose eval-visible metadata

Use a `finish` provider when the Capability should publish invocation metadata for finish hooks, channel delivery code, or eval assertions.
The value is keyed by Capability id and is available through `observation.extensions.get(id)` in Agent Evals.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from '@vite-hub/agent'

export function tickets() {
  return defineCapability({
    id: 'tickets',
    finish(event) {
      return {
        resultKind: typeof event.result,
        status: event.error ? 'failed' : 'completed',
      }
    },
  })
}
```

```ts [server/agents/support.eval.ts]
import { defineEval, hasCapabilityExtension } from '@vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [{
    name: 'uses ticket boundary',
    input: { prompt: 'Find the open billing ticket' },
    scorers: [
      hasCapabilityExtension('tickets', 'status'),
    ],
  }],
})
```

## Reference

- [Capabilities overview](/docs/capabilities)
- [Official capabilities](/docs/capabilities/official-capabilities)
- Source: `packages/agent/src/capability-runtime.ts`
