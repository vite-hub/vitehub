---
title: memory()
description: Add scoped durable memory records to an Agent.
navigation.title: memory()
navigation.order: 160
icon: i-lucide-brain
---

`memory()` adds scoped durable records that an Agent can search, read, preload, remember, or delete through configured Memory Stores.
Memory is explicit Agent behavior and is not the same as Chat History.

## What it adds

The Capability can preload selected memory records into instructions, expose `memory_search` and `memory_read`, and expose write tools when a store opts into tool writes.
Each store owns its adapter, scope, allowed kinds, read behavior, and write policy.

## Minimum attach example

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

During input, `memory()` can preload records from configured stores into Capability instruction blocks.
During resolve, it creates read tools for stores that allow reading and write tools for stores that opt into tool writes.

Write tools add provenance from the current Agent Invocation and require approval by default unless the store policy changes it.

## Requirements

`memory()` requires a store map.
Each store requires an adapter and an explicit non-empty scope.

`workspaceJsonlMemoryStore()` requires a Workspace.
It requires writable Workspace access when the Agent creates, supersedes, or deletes memory records.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives preload instructions and model-facing memory tools. |
| Harness-backed | Runtime preload can run; model-facing memory tools are not passed by default. |
| Custom-run-backed | Receives prepared context and can call store adapters from custom code when the application exposes them. |

## Inspect and verify

Inspect instruction blocks for `memory.<store>` preload entries.
Inspect the tool list and confirm write tools appear only for stores with `write.mode: 'tool'`.

For the workspace JSONL store, inspect the configured Workspace file and verify records include scope and provenance.

## Reference

- [chat()](/docs/capabilities/chat)
- [Workspace primitive](/docs/server-primitives/workspace)
- Source: `packages/agent/src/capabilities/memory.ts`
