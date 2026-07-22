---
title: Memory
description: Add scoped durable memory records to an Agent.
navigation.title: Memory
navigation.order: 160
navigation.group: Workspace
icon: i-lucide-brain
---

`memory()` adds scoped durable records that an Agent can search, read, remember, or delete through configured Memory Stores.
Memory is explicit Agent behavior and is not the same as Chat History.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability exposes `memory_search` and `memory_read`, plus remember and delete tools when a store opts into tool writes.
Each store owns its adapter, scope, allowed kinds, read behavior, and write policy.

## Configuration

Configure at least one store with an explicit scope.
The workspace JSONL helper stores records inside the Agent Workspace.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { memory, workspaceJsonlMemoryStore } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    memory({
      stores: {
        agent: {
          adapter: workspaceJsonlMemoryStore(),
          scope: { agent: 'support' },
        },
      },
    }),
  ],
})
```

## Runtime behavior

During resolve, `memory()` creates read tools for stores that allow reading and write tools for stores that opt into tool writes.

Write tools add provenance from the current Agent Invocation and allow writes by default after a store opts into `write.mode: 'tool'`.
Set the store policy to `require-approval` or `deny` when writes need an additional gate.

## Requirements

`memory()` requires a store map.
Each store requires an adapter and an explicit non-empty scope.

`workspaceJsonlMemoryStore()` requires a Workspace.
It requires writable Workspace access when the Agent creates, supersedes, or deletes memory records.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the configured memory tools. |
| Harness-backed | Receives the configured memory tools through the Harness tool bridge. |
| Custom-run-backed | Receives prepared context and can call store adapters from custom code when the application exposes them. |

## Inspect and verify

Inspect Agent inspection metadata for the configured memory stores.
Inspect the tool list and confirm write tools appear only for stores with `write.mode: 'tool'`.

For the workspace JSONL store, inspect the configured Workspace file and verify records include scope and provenance.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stores` | `Record<string, MemoryStoreOptions>` | required | Named Memory Stores available to the Agent. |
| `stores.*.adapter` | `MemoryStoreAdapter \| MemoryStoreFactory` | required | Store implementation. |
| `stores.*.scope` | `MemoryScope \| function` | required | Scope attached to all operations for that store. |
| `stores.*.allowKinds` | `MemoryKind[]` | all kinds | Allowed memory kinds for the store. |
| `stores.*.read.tools.search` | `boolean` | `true` | Expose memory search. |
| `stores.*.read.tools.read` | `boolean` | `true` | Expose exact memory read. |
| `stores.*.write.mode` | `"off" \| "tool"` | `"off"` | Expose remember/delete tools when set to `"tool"`. |
| `stores.*.write.policy` | `AgentToolPolicyDecision` | `"allow"` | Policy for write tools. |

### Workspace JSONL store

`workspaceJsonlMemoryStore()` persists records as append-only JSONL inside the Agent Workspace.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"memory/memory.jsonl"` | Workspace-relative JSONL file path. |

Cover Memory usage guidance in Agent Driver Instructions with explicit Capability coverage blocks. Keep memory tool descriptions with the tool definitions because they are structured tool contracts.

## Reference

- [chat()](/docs/capabilities/chat)
- [Workspace primitive](/docs/server-primitives/workspace)
- Source: `packages/agent/src/capabilities/memory.ts`
