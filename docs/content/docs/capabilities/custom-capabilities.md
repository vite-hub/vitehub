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
The tool schema only accepts registered executable names, and each call runs inside a trusted Workspace Session.

`bash` is a runtime tool surface, not a Capability factory.
Do not create a `bash()` Capability or use `workspaceShell()` as the public owner for product-specific executables.

## Add a Capability CLI

Use `cli` when the Capability owns a real command tree that agents and developers should run instead of a generic shell command.
The public API is a flat object on the Capability Definition.

```ts [server/agents/capabilities/inventory-runtime.ts]
import { defineCapability } from '@vite-hub/agent'
import { z } from 'zod'

const inventoryItemsInput = z.object({
  limit: z.number().int().positive().optional(),
})

const inventoryItemsOutput = z.object({
  items: z.array(z.object({ id: z.string() })),
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

The `input` and `output.schema` values accept any Standard Schema-compatible validation library. Use Zod, Valibot, ArkType, or the validator your app already uses.

ViteHub exposes command metadata through the generated CLI-named tool. Keep `instructions.md` focused on policy and use `::capability{key="inventoryRuntime"}` when authored guidance should cover that Capability.

First-party adapters can generate the same CLI shape from their own metadata. For example, `openapi({ cli: { name: 'billing' }, ... })` creates one subcommand per allowed OpenAPI operation and preserves each operation summary or description in the tool contract.
Custom Capability authors still pass a flat `cli` object; dynamic command generation belongs behind adapter-owned options such as `openapi({ cli })`.

During development, run the Capability CLI through the Agent Dev Loop.
Agents expose attached Capability CLI Contributions to compatible Agent Driver and Agent Dev Loop surfaces by default; use `defineAgent({ cli: { capabilities: false } })` when an Agent should attach the Capability but keep its CLI hidden.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

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
