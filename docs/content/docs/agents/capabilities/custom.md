---
title: Custom capabilities
description: Write your own Capability when your Agent needs an ability that the built-in ones do not give.
navigation.title: Custom capabilities
navigation.order: 73
navigation.group: Advanced
icon: i-lucide-wrench
navigation.kind: Guides
---

Write your own Capability when the [official catalog](/docs/agents/capabilities/official) lacks the ability your product needs. Start from the ability, such as "search support tickets", not a raw tool or primitive call. Inspection shows the tools, triggers, context values, metadata, and policy decisions it adds.

## Minimum shape

Put it next to the app code that owns the behavior. `defineCapability()` checks the id and runs the normal lifecycle.

```ts [server/capabilities/tickets.ts] fragment
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
        title: 'Searched tickets',
        icon: 'i-lucide-ticket',
        description: 'Search support tickets by query.',
        inputSchema: searchTicketsInput,
        execute: async input => searchTickets(input.query),
      },
    },
  })
}
```

`inputSchema` takes raw JSON Schema or a validator that implements Standard Schema and Standard JSON Schema, such as Zod 4. ViteHub bundles no validator; use your app's.

- Inline tools infer the handler input from the validator output, including transforms and optional values. TypeScript rejects a mismatched handler.
- Raw JSON Schema has no output type, so type its handler input yourself.
- Resolver-returned tools also check typed handler inputs against their schemas.
- AI SDK `tool()` definitions and provider-native tools keep their own types.

For a runtime config type, use `defineCapability<Config>()({...})`; the inner call infers the tools. Replace the old `defineCapability<Config>({...})` form, which could not infer tool schemas.

Optional `title` and `icon` are display only. The model never sees them, and they do not change the configuration fingerprint.

| Field | Use |
| --- | --- |
| `title` | Short past-tense label, such as `Searched tickets`. Traces record it as `tool.title` when the driver event has none. The Console shows it instead of the tool name. |
| `icon` | Iconify name, such as `i-lucide-ticket`. The Console has the [Lucide](https://lucide.dev/icons/) set and shows it on each call and in the tool list. |

The catalog saves `title` as `label`. Metadata-only journals keep `label` and `icon` but drop per-call `tool.title` (trace content), so the Console reads the catalog label.

Attach it like an official Capability. Keep instructions in the Agent Driver, not hidden in Capability config.

```ts [server/agents/support.ts] fragment
import { defineAgent } from 'vite-hub/agent'
import { tickets } from '../capabilities/tickets'

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

## Extend an inherited Capability

With [`extends`](/docs/agents/agent-presets#extend-an-agent), a child Capability with the same `id` replaces the parent's. To combine them, add `extend(inherited)`: it gets the parent's Capability and returns the child's, with the same `id`. [`mcp()`](/docs/agents/capabilities/mcp#extend-the-parents-servers) uses it to merge servers by name.

## Add requirements

A requirement fails before the Capability adds anything. Add one for a configured primitive, a Workspace, a writable Workspace, or a Workspace path. Never create missing storage, paths, or permissions silently; provisioning belongs in the primitive or framework integration.

## Add policy

Policy defaults to `allow`. Use `require-approval` or `deny` when a tool needs a runtime check after modes, scopes, allowlists, and input validation. Keep policy small enough that a reviewer sees what it allows in the Capability Definition.

## Contribute Workspace inputs

`workspace` adds Workspace Sources or rules for one Invocation (one Agent run). It only adds, is inspectable, and never changes your Workspace Definition.

```ts [server/capabilities/tickets.ts] fragment
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

For provider-backed Agents, declare files in `requires.workspace.paths` or add them as Sources. The Provider Workspace session materializes the selected scope, so no provider-specific path list is needed.

## Add a Capability CLI

`cli` gives the Capability its own commands, run instead of a generic shell command. Pass a static command tree or a per-run resolver.

```ts [server/capabilities/inventory-runtime.ts] fragment
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

`input` and `output.schema` accept any Standard Schema library. The command metadata goes into a generated tool named after the CLI. Keep `instructions.md` about policy, and mark guidance with `::capability{key="inventoryRuntime"}`.

Return `undefined` from the resolver to hide the CLI for this run; the Capability stays attached and inspectable. To drop the whole Capability, use a `capabilities` callback, which decides before any tools, commands, requirements, hooks, or cleanup are added.

```ts [server/capabilities/inventory-runtime.ts] fragment
export const inventoryRuntime = defineCapability({
  id: 'inventory-runtime',
  cli: ({ invoker }) => invoker.kind === 'support'
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

Built-in adapters generate the same shape. `openapi({ cli: { name: 'billing' }, ... })` makes one subcommand per allowed operation and keeps each summary or description. Use a resolver for per-run availability, not to change command ownership mid-run.

Attached Capability CLIs reach compatible Drivers and the Agent Dev Loop (`vitehub agent dev`) by default; run them there in development. `defineAgent({ cli: { capabilities: false } })` hides them.

```bash [Terminal]
pnpm vitehub agent dev --url http://localhost:3000 --agent support --cli inventory -- items list --json
```

## Driver support

| Agent Driver | Custom Capability behavior |
| --- | --- |
| Model-backed | Gets the Capability's model tools. |
| Provider-backed | Gets Agent tools through the private MCP bridge, plus supported runtime effects. No Provider Tool contributions. |
| Custom-run-backed | Gets prepared input and context. `driver.run` picks which outputs to use. |

## Verify a custom Capability

Run the Agent with `vitehub agent dev` and check the streamed tool events: the id appears once, requirements pass, and tools appear only when expected. When product behavior changes, add an Agent Eval with a small fixture that proves the intended ability and no adjacent authority.

## Expose eval-visible metadata

A `finish` provider gives run data to finish hooks, Channel delivery code, or evals, keyed by Capability id. Agent Evals read it with `observation.extensions.get(id)`.

```ts [server/capabilities/tickets.ts]
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

- [Capabilities overview](/docs/agents/capabilities)
- [Official capabilities](/docs/agents/capabilities/official)

## Contribute an inspection view

The Console's **Capabilities** tab shows each recorded Capability's tools and configuration. For a custom view, add `inspection` and send data with `await context.inspection.set(state)` during the lifecycle.

```ts [server/capabilities/tickets.ts]
import { defineCapability } from 'vite-hub/agent'

export const tickets = defineCapability({
  id: 'tickets',
  inspection: {
    label: 'Tickets',
    view: {
      root: 'summary',
      elements: {
        summary: { type: 'Stack', props: {}, children: ['status', 'tools'] },
        status: {
          type: 'KeyValue',
          props: { label: 'Index', value: { $state: '/status' } },
        },
        tools: { type: 'Tools', props: {} },
      },
    },
  },
  async configure(context) {
    await context.inspection.set({ status: 'Ready' })
  },
})
```

- `inspection.set()` replaces the state for this run. Await it to record it before the next step.
- Keep state serializable, and send only data the Capability already made.
- The Console reads snapshots. Opening a view runs no hooks, services, or tools. The last snapshot stays after cleanup.
- The view and state do not change the configuration fingerprint.

The view is a read-only part of [JSON Render](https://github.com/vercel-labs/json-render). ViteHub owns the Vue components; Capability code imports neither Vue nor the Console.

| Component | Props | Purpose |
| --- | --- | --- |
| `Stack` | None | Arrange child elements vertically. |
| `Section` | `title` | Group children under a heading. |
| `Text` | `text` | Display plain text. |
| `KeyValue` | `label`, `value` | Display a named value, including structured JSON. |
| `Tools` | Optional `names`, `mcpServer` | This Capability's recorded tool contracts. Filter by final tool name or MCP server; omit both for all. |

`{ $state: '/path' }` reads state. A container repeats children with `repeat: { statePath: '/items', key: 'id' }`, and they read the item with `{ $item: '/field' }`. `children` holds element IDs. The `AgentCapabilityInspectionView` type checks names and props. The Console rejects unknown components, actions, computed expressions, and cyclic trees, and shows the recorded data and tools instead.

State and view specs follow the journal's configuration retention; `configuration: 'content'` keeps them apart from prompts and output. Credential-shaped keys are redacted. Observation limits apply, so a truncated snapshot can miss part of the view. The label survives metadata-only capture. Telemetry exporters keep custom inspection content only with `instructions`, `inputs`, and `outputs` all on, since state can hold any of them.

MCP and Title have custom views; other official Capabilities use the default.

### Transform MCP tools

`context.tools.transform()` changes the Driver's tools in every run, including Capability CLI tools. `vitehub agent dev --cli` runs commands directly, without transforms.

The callback gets a copy of each definition with its prototype, property flags, and accessors. Accessors and executors are bound, so they keep their instance as `this`, private fields included, but their identity can change. A definition shared under several keys stays separate per key. Rename local tools from the supplied definitions so inspection keeps their owner.

A transform can remove, replace (same key, keeping its MCP provenance), or rename MCP tools. A rename must keep `metadata.mcpServer` and `metadata.originalName`, even when it rebuilds the tool:

```ts fragment
context.tools.transform(tools => ({
  lookup: {
    name: 'lookup',
    description: 'Look up a document',
    inputSchema: tools!.mcp_docs_read!.inputSchema,
    execute: tools!.mcp_docs_read!.execute,
    metadata: { ...tools!.mcp_docs_read!.metadata },
  },
}))
```

Moving existing non-MCP tools to new keys keeps their original owner in inspection, even after an earlier same-key replacement.

> [!WARNING]
> Removing MCP keys while adding rebuilt tools without provenance fails with `AGENT_R0923`, since the server cannot be inferred. Add unrelated tools with `context.tools.add()` and remove MCP entries in the transform.
