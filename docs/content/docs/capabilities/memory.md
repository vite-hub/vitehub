---
title: Memory
description: Add scoped durable memory records that an Agent can search, read, remember, and delete.
navigation.title: Memory
navigation.order: 160
navigation.group: Workspace
icon: i-lucide-brain
---

`memory()` adds scoped durable records that an Agent can search, read, remember, or delete through configured Memory Stores. It adds `memory_search` and `memory_read`, plus `memory_remember` and `memory_delete` when a store opts into tool writes. Memory is explicit Agent behavior. It is not the same as Chat History.

Each store owns its adapter, scope, allowed kinds, read tools, and write policy. The built-in `workspaceJsonlMemoryStore()` keeps records in the Agent [Workspace](/docs/server-primitives/workspace).

## Configure memory

Configure at least one store with an explicit scope.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { memory, workspaceJsonlMemoryStore } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    memory({
      stores: {
        agent: {
          adapter: workspaceJsonlMemoryStore(),
          scope: { agent: 'support' },
          write: { mode: 'tool', policy: 'require-approval' },
        },
      },
    }),
  ],
})
```

## Agent-visible tool contract

| Tool | Added when | Input |
| --- | --- | --- |
| `memory_search` | A store allows search. | `query` (required), `store`, `kinds`, `tags`, `after`, `before`, `limit` |
| `memory_read` | A store allows exact reads. | `id` (required), `store` |
| `memory_remember` | A store sets `write.mode: 'tool'`. | `content` and `kind` (required), `store`, `title`, `tags`, `metadata`, `pinned`, `confidence`, `supersedes`, `provenance` |
| `memory_delete` | A store sets `write.mode: 'tool'`. | `id` (required), `store`, `reason` |

The Agent can omit `store` when the Capability has one store or a store named `agent`. Otherwise it must pass `store`.

## How memory works

When the Capability resolves, `memory()` creates each store adapter and resolves each store scope. Every operation uses the store scope, so the Agent cannot read or write records in another scope.

`memory_remember` adds provenance from the current Agent Invocation: `runId`, `threadId`, `source: 'tool'`, and `toolName: 'memory_remember'`. When `supersedes` lists record ids, the store marks those records as superseded. `memory_delete` is a soft delete. The JSONL store appends a tombstone and keeps the original line.

`memory_remember` checks `allowKinds` for the selected store. Tool calls for a store that does not allow the operation fail.

### Workspace JSONL store

`workspaceJsonlMemoryStore()` appends records, supersede events, and delete tombstones to a JSONL file in the Agent Workspace. Each line has the store name, scope, version, and a digest (SHA-256 when Web Crypto is available). Search counts case-insensitive matches of `query` in the title, content, and tags, and returns 10 results by default.

## Requirements

- `memory()` requires a `stores` map. Each store requires an adapter and a scope with at least one non-empty field.
- `workspaceJsonlMemoryStore()` requires a Workspace. It requires write access when the Agent remembers or deletes records.
- A custom adapter implements `search`, `read`, `append`, `delete`, and `export`. A `MemoryStoreFactory` has a `kind` and a `create(context)` function that returns the adapter.

## Security and approval

Read tools never require approval. Write tools exist only for stores with `write.mode: 'tool'`.

Set `write.policy` on a store to gate writes:

- `"allow"` (default): run `memory_remember` and `memory_delete` without approval.
- `"require-approval"`: stop the call with an approval request. The write runs after a user approves it.
- `"deny"`: reject writes to that store.

The store scope comes from configuration or from a scope function that receives the Capability context. The model cannot change it. Model input can set `kind`, `tags`, `metadata`, and `provenance` fields. Provenance values from the model replace the invocation defaults, so do not treat stored provenance as trusted authority.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the configured memory tools. |
| Provider-backed | Receives the configured memory tools through the provider MCP bridge. |
| Custom-run-backed | Receives the configured memory tools in `driver.run({ tools })`. |

## Verify memory

1. Run `vitehub agent dev --agent <name>` and ask the Agent to search its memory. Confirm that the stream shows a `memory_search` tool step. `agent info` does not list memory tools because the Capability adds them at invocation time.
2. Confirm that `memory_remember` and `memory_delete` appear only when a store sets `write.mode: 'tool'`.
3. For the JSONL store, call `memory_remember` and confirm that the Workspace file has a line with the store scope and provenance.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stores` | `Record<string, MemoryStoreOptions>` | required | Named Memory Stores available to the Agent. |
| `stores.*.adapter` | `MemoryStoreAdapter \| MemoryStoreFactory` | required | Store implementation. |
| `stores.*.scope` | `MemoryScope \| (context) => MemoryScope` | required | Scope for every operation on the store. Fields: `agent`, `environment`, `project`, `session`, `tenant`, `thread`, `user`, `workspace`. |
| `stores.*.allowKinds` | `MemoryKind[]` | all kinds | Kinds that `memory_remember` accepts, for example `"episodic"`, `"procedural"`, `"profile"`, or `"semantic"`. |
| `stores.*.read.tools.search` | `boolean` | `true` | Allow `memory_search` for the store. |
| `stores.*.read.tools.read` | `boolean` | `true` | Allow `memory_read` for the store. |
| `stores.*.write.mode` | `"off" \| "tool"` | `"off"` | Add `memory_remember` and `memory_delete` when set to `"tool"`. |
| `stores.*.write.policy` | `AgentToolPolicyDecision` | `"allow"` | Policy for write tools on the store. |
| `stores.*.retention` | `{ export?: boolean; hardDelete?: boolean }` | none | Reserved retention settings. `memory()` does not read them. |

### Workspace JSONL store options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"memory/memory.jsonl"` | Workspace-relative JSONL file path. |

## Related pages

- [Workspace primitive](/docs/server-primitives/workspace)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [chat()](/docs/capabilities/chat)
- [Agent instructions](/docs/agents/instructions)
- [Official Capabilities](/docs/capabilities/official-capabilities)
