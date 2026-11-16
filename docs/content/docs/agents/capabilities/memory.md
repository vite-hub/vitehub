---
title: Memory
description: Give an Agent memory that lasts between runs. It can search, read, save, and delete records.
navigation.title: Memory
navigation.order: 260
navigation.group: Capabilities
icon: i-lucide-brain
---

`memory()` gives an Agent records that last between runs, kept in Memory Stores you configure. It adds `memory_search` and `memory_read`, plus `memory_remember` and `memory_delete` when a store allows tool writes. Unlike Chat History, the Agent saves a memory only by calling a tool.

Each store sets its adapter, scope, allowed kinds, read tools, and write policy. The built-in `workspaceJsonlMemoryStore()` keeps records in the Agent [Workspace](/docs/workspace), the Agent's files.

## Configure memory

Configure at least one store with a scope.

```ts [server/agents/support.ts] fragment
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
| `memory_search` | Search allowed. | `query` (required), `store`, `kinds`, `tags`, `after`, `before`, `limit` |
| `memory_read` | Exact reads allowed. | `id` (required), `store` |
| `memory_remember` | `write.mode: 'tool'` | `content` and `kind` (required), `store`, `title`, `tags`, `metadata`, `pinned`, `confidence`, `supersedes`, `provenance` |
| `memory_delete` | `write.mode: 'tool'` | `id` (required), `store`, `reason` |

The Agent can omit `store` only when there is one store or a store named `agent`.

## How memory works

At start, `memory()` creates each store adapter and resolves its scope. Every operation stays in that scope.

- `memory_remember` checks the store's `allowKinds` and adds provenance from the current Invocation (one Agent run): `runId`, `threadId`, `source: 'tool'`, and `toolName: 'memory_remember'`.
- Record ids in `supersedes` are marked as replaced.
- `memory_delete` is a soft delete. The JSONL store appends a tombstone and keeps the original line.
- A call fails when the store does not allow the operation.

### Workspace JSONL store

`workspaceJsonlMemoryStore()` appends records, replace events, and delete tombstones to a JSONL file in the Workspace. Each line has the store name, scope, version, and a digest (SHA-256 when Web Crypto is available). Search counts case-insensitive matches of `query` in title, content, and tags, and returns 10 results by default.

## Requirements

- `memory()` requires a `stores` map. Each store needs an adapter and a scope with at least one non-empty field. A store with `retention` fails with `AGENT_R0120`, because `memory()` has no retention.
- The JSONL store reads a missing file as empty memory. Any other read error fails the tool call, so a broken Workspace does not look like empty memory.
- `workspaceJsonlMemoryStore()` requires a Workspace, writable when the Agent remembers or deletes.
- A custom adapter implements `search`, `read`, `append`, `delete`, and `export`. A `MemoryStoreFactory` has a `kind` and a `create(context)` function that returns the adapter.

## Security and approval

Read tools never need approval. Write tools exist only with `write.mode: 'tool'`. `write.policy` controls them:

- `"allow"` (default): no approval.
- `"require-approval"`: runs after a user approves.
- `"deny"`: rejects writes.

The scope comes from configuration or a scope function that gets the Capability context. The model cannot change it, but it can set `kind`, `tags`, `metadata`, and `provenance`.

> [!WARNING]
> Model provenance replaces the run's defaults, so stored provenance is not trusted proof of origin.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Gets the memory tools. |
| Provider-backed | Gets the memory tools through the provider MCP bridge. |
| Custom-run-backed | Gets the memory tools in `driver.run({ tools })`. |

## Verify memory

1. Run `vitehub agent dev --agent <name>`, ask the Agent to search its memory, and check for a `memory_search` step. `agent info` does not list memory tools, because they are added when the run starts.
2. Check that `memory_remember` and `memory_delete` appear only with `write.mode: 'tool'`.
3. For the JSONL store, call `memory_remember` and check the Workspace file for a line with the scope and provenance.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `stores` | `Record<string, MemoryStoreOptions>` | required | Named Memory Stores. |
| `stores.*.adapter` | `MemoryStoreAdapter \| MemoryStoreFactory` | required | Store implementation. |
| `stores.*.scope` | `MemoryScope \| (context) => MemoryScope` | required | Scope of every store operation. Fields: `agent`, `environment`, `project`, `session`, `tenant`, `thread`, `user`, `workspace`. |
| `stores.*.allowKinds` | `MemoryKind[]` | all kinds | Kinds `memory_remember` accepts, such as `"episodic"`, `"procedural"`, `"profile"`, or `"semantic"`. |
| `stores.*.read.tools.search` | `boolean` | `true` | Allow `memory_search` for the store. |
| `stores.*.read.tools.read` | `boolean` | `true` | Allow `memory_read` for the store. |
| `stores.*.write.mode` | `"off" \| "tool"` | `"off"` | `"tool"` adds `memory_remember` and `memory_delete`. |
| `stores.*.write.policy` | `AgentToolPolicyDecision` | `"allow"` | Policy for write tools on the store. |

### Workspace JSONL store options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `path` | `string` | `"memory/memory.jsonl"` | Workspace-relative JSONL file path. |

## Related pages

- [Workspace primitive](/docs/workspace)
- [Chat History and sessions](/docs/agents/chat-history-sessions)
- [chat()](/docs/agents/capabilities/chat)
- [Agent instructions](/docs/agents/instructions)
- [Official Capabilities](/docs/agents/capabilities/official)
