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

A custom Capability names what the Agent can do and declares the requirements it needs. Inspection output lists the tools, triggers, context values, metadata, and policy decisions contributed by that Capability.

## Minimum shape

Define the Capability near the application code that owns the behavior.
Use `defineCapability()` so ViteHub validates the id and composes the Capability through the normal lifecycle.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from 'vite-hub/agent'
import { z } from 'zod'

const searchTicketsInput = z.object({
  query: z.string(),
})

export function tickets() {
  return defineCapability({
    id: 'tickets',
    tools: {
      searchTickets: {
        name: 'searchTickets',
        description: 'Search support tickets by query.',
        inputSchema: searchTicketsInput,
        execute: async (input: z.output<typeof searchTicketsInput>) => searchTickets(input.query),
      },
    },
  })
}
```

Agent tools accept raw JSON Schema or a validator that implements both Standard Schema and Standard JSON Schema. Zod 4 implements both directly. ViteHub does not bundle a validator; use the one your app owns.

Attach the custom Capability like any official Capability.
Keep instructions explicit in the Agent Driver so Capability config does not become a hidden prompt bag.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
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

Tool policy defaults to `allow` when omitted.
Use `require-approval` or `deny` when a model-facing action needs an additional runtime gate after the Capability has established its modes, scopes, allowlists, and input validation.

Keep custom policy narrow and visible. A reviewer needs to understand the operations it permits by reading the Capability Definition.

## Contribute Workspace inputs

Use `workspace` to add Workspace Sources or rules for an invocation.
The contribution is add-only and inspectable; it does not mutate the Agent's authored Workspace Definition.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from 'vite-hub/agent'

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

For provider-backed Agents, declare required files through `requires.workspace.paths` or contribute them through Workspace Sources. The Provider Workspace session materializes the selected scope, so the application does not need a provider-specific path list.

## Add a Capability CLI

Use `cli` when the Capability owns commands that agents and developers can run instead of a generic shell command.
The public API accepts a static command tree or an invocation resolver on the Capability Definition.

```ts [server/agents/capabilities/inventory-runtime.ts]
import { defineCapability } from 'vite-hub/agent'
import * as v from 'valibot'

const inventoryItemsInput = v.object({
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
})

const inventoryItemsOutput = v.object({
  items: v.array(v.object({ id: v.string() })),
})

export const inventoryRuntime = defineCapability({
  id: 'inventory-runtime',
  cli: {
    name: 'inventory',
    description: 'Inspect live inventory data.',
    commands: {
      items: {
        description: 'Inventory item data.',
        commands: {
          list: {
            description: 'List inventory items for the current application context.',
            input: inventoryItemsInput,
            output: { format: 'json', schema: inventoryItemsOutput },
            effects: ['read', 'network:inventory'],
            async run({ input }) {
              return await listInventoryItems(input)
            },
          },
        },
      },
    },
  },
})
```

The `input` and `output.schema` values accept any Standard Schema-compatible validation library.

ViteHub exposes command metadata through the generated CLI-named tool. Keep `instructions.md` focused on policy. Use `::capability{key="inventoryRuntime"}` to mark guidance for that Capability.

Return `undefined` from a resolver to hide the CLI for the current invocation. The Capability remains attached and inspectable.

To omit the entire Capability, resolve the Agent Definition's `capabilities` list instead. This decides selection before the Capability contributes tools, CLI commands, requirements, hooks, or cleanup work.

```ts [server/agents/capabilities/inventory-runtime.ts]
export const inventoryRuntime = defineCapability({
  id: 'inventory-runtime',
  cli: ({ actor }) => actor.kind === 'support'
    ? {
        name: 'inventory',
        commands: {
          list: {
            run: () => listInventoryItems(),
          },
        },
      }
    : undefined,
})
```

First-party adapters can generate the same CLI shape from their own metadata. For example, `openapi({ cli: { name: 'billing' }, ... })` creates one subcommand per allowed OpenAPI operation and preserves each operation summary or description in the tool contract.
Use a resolver for invocation-specific availability, not to mutate command ownership after a run starts.

During development, run the Capability CLI through the Agent Dev Loop.
Agents expose attached Capability CLI Contributions to compatible Agent Drivers and the Agent Dev Loop by default. Use `defineAgent({ cli: { capabilities: false } })` to attach the Capability without exposing its CLI.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

## Driver support

| Agent Driver | Custom Capability behavior |
| --- | --- |
| Model-backed | Receives model-facing tools when the Capability contributes them. |
| Provider-backed | Receives Agent tools through the private MCP bridge plus supported runtime effects. Provider Tool contributions are unsupported. |
| Custom-run-backed | Receives prepared input and invocation context; `driver.run` decides which custom Capability outputs to consume. |

## Verify a custom Capability

Run one Agent Invocation through `vitehub agent dev` and inspect its streamed tool events.
Check that the custom Capability id appears once, its requirements pass, and its tools are exposed only when expected.

Add an Agent Eval when the Capability changes product behavior.
Use a focused fixture that proves the Capability exposes the intended ability and does not expose adjacent authority.

## Expose eval-visible metadata

Use a `finish` provider to publish invocation metadata for finish hooks, channel delivery code, or eval assertions.
The value is keyed by Capability id and is available through `observation.extensions.get(id)` in Agent Evals.

```ts [server/agents/capabilities/tickets.ts]
import { defineCapability } from 'vite-hub/agent'

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
import { defineEval, hasCapabilityExtension } from 'vite-hub/agent/eval'
import support from './support'

export default defineEval({
  agent: support,
  scenarios: [{
    name: 'uses ticket context',
    input: { prompt: 'Find the open billing ticket' },
    scorers: [
      hasCapabilityExtension('tickets', 'status'),
    ],
  }],
})
```

## Related APIs

- [Capabilities overview](/docs/capabilities)
- [Official capabilities](/docs/capabilities/official-capabilities)
