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

Tool policy defaults to `allow` when omitted.
Use `require-approval` or `deny` when a model-facing action needs an additional runtime gate after the Capability has established its modes, scopes, allowlists, and input validation.

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

For harness-backed Agents, declare files a Capability needs through `requires.workspace.paths` or contribute them through Workspace Sources. The harness Workspace Session materializes the selected Workspace scope; applications should not maintain a separate harness-specific path list.

## Contribute bash commands

Use `bash` when a Capability owns a real executable that should appear in ViteHub's global model-facing `bash` tool.
Each entry can be an executable name or an object with a command, description, and optional install package name.

```ts [server/agents/capabilities/browser-preview.ts]
import { defineCapability } from '@vite-hub/agent'

export function browserPreview() {
  return defineCapability({
    id: 'browser-preview',
    bash: [
      {
        command: 'agent-browser',
        description: 'Run headless browser.',
        install: 'agent-browser',
      },
    ],
  })
}
```

ViteHub merges all Capability `bash` entries into one `bash` tool.
The tool schema only accepts registered executable names, and each call runs inside an executable Workspace Session.

`bash` is a runtime tool surface, not a Capability factory.
Do not create a `bash()` Capability or use `workspaceShell()` as the public owner for product-specific executables.
Read the [Bash concept](/docs/concepts/bash) for the execution model and its relationship to Workspace Shell, Shell, Workspace Sessions, and Sandbox.

## Add a Capability CLI

Use `cli` when the Capability owns a real command tree that agents and developers should run instead of a generic shell command.
The public API accepts a static command tree or an invocation resolver on the Capability Definition.

```ts [server/agents/capabilities/inventory-runtime.ts]
import { defineCapability } from '@vite-hub/agent'
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

ViteHub exposes command metadata through the generated CLI-named tool. Keep `instructions.md` focused on policy and use `::capability{key="inventoryRuntime"}` when authored guidance should cover that Capability.

Return `undefined` from a resolver when the CLI should not be available for the current invocation. The Capability remains attached and inspectable.

When the entire Capability should be absent, resolve the Agent Definition's `capabilities` list instead. This keeps selection at the composition boundary, before the Capability can contribute tools, CLI commands, requirements, hooks, or cleanup work.

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
Agents expose attached Capability CLI Contributions to compatible Agent Driver and Agent Dev Loop surfaces by default; use `defineAgent({ cli: { capabilities: false } })` when an Agent should attach the Capability but keep its CLI hidden.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

## Driver support

| Agent Driver | Custom Capability behavior |
| --- | --- |
| Model-backed | Receives model-facing tools when the Capability contributes them. |
| Harness-backed | Receives Agent tools through the Harness tool bridge plus supported runtime effects and harness-compatible contributions. Provider Tool contributions are unsupported. |
| Custom-run-backed | Receives prepared input and invocation context; `driver.run` decides which custom Capability outputs to consume. |

## Inspect and verify

Run one Agent Invocation through `vitehub agent dev` and inspect its streamed tool events.
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
