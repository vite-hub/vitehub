---
title: Capabilities
description: Add agent abilities with composable ViteHub capabilities.
---

Capabilities are agent-scoped plugins for ViteHub agents. They can contribute instructions, tools, input transforms, preparation work, and cleanup behavior without moving storage configuration out of the workspace.

```ts
import { openai } from "@ai-sdk/openai"
import { defineAgent } from "@vitehub/agent"
import {
  db,
  inputCommands,
  kv,
  memory,
  mcp,
  skills,
  transcribe,
  workspaceJsonlMemoryStore,
} from "@vitehub/agent/capabilities"

export default defineAgent({
  workspace: {
    // Storage and workspace sources stay configured here.
  },
  instructions: `
You are a helpful agent.

{{ skills }}

Use external tools only when useful:
{{ mcp }}

{{ capabilities }}
  `,
  capabilities: [
    skills(),
    transcribe({
      model: openai.transcription("gpt-4o-mini-transcribe"),
    }),
    inputCommands({
      commands: {
        summarize: {
          description: "Summarize the requested context.",
          run: async ({ args }) => `Summarize: ${args}`,
        },
      },
    }),
    mcp({
      servers: {
        docs: {
          transport: {
            type: "http",
            url: "https://example.com/mcp",
          },
        },
      },
    }),
    db({ access: "read" }),
    kv({ access: "write" }),
    memory({
      stores: {
        agent: {
          adapter: workspaceJsonlMemoryStore(),
          scope: { agent: "support" },
          allowKinds: ["semantic", "episodic", "procedural"],
          read: {
            preload: [{ kind: "procedural", pinned: true }],
          },
          write: {
            mode: "tool",
          },
        },
      },
    }),
  ],
})
```

Instruction blocks can be placed with `{{ capabilityId }}` slots. `{{ capabilities }}` inserts any blocks that have not already been placed, and remaining blocks are appended in capability order.

Official capabilities currently include `skills()`, `transcribe()`, `inputCommands()`, `mcp()`, `db()`, `kv()`, and `memory()`.

`transcribe()` mirrors the AI SDK transcription API. ViteHub supplies `audio` from incoming audio message parts, while the capability accepts AI SDK transcription options such as `model`, `providerOptions`, `headers`, `maxRetries`, and `download`. Use `execute` only when you need a custom transcription implementation.

`inputCommands()` transforms command-style input before the model runs. Registered slash commands such as `/summarize last week` can return a replacement string or an `AgentRunInput` patch. Unknown slash commands pass through as normal user input. Input commands do not inject system instructions.

`mcp()` accepts AI SDK MCP client configuration for each MCP Server. ViteHub creates and closes the clients with the Agent run, then exposes each server's tools with stable `mcp_<server>_<tool>` names so multiple MCP Servers can be attached to one Agent.

`memory()` gives an Agent durable scoped records across invocations. It is separate from Chat History: Chat History replays recent conversation context, while Memory stores explicit records that can outlive a thread. The first store is `workspaceJsonlMemoryStore()`, which persists append-only JSONL records in the Agent workspace at `.vitehub/memory/agent.jsonl`.

Each Memory Store requires an explicit `scope`. Use stable values such as the agent name, workspace name, project id, or environment so records do not leak between agents that happen to share the same store path.

Memory tools are record-oriented:

| Tool | Purpose |
| --- | --- |
| `memory_search` | Search active scoped records |
| `memory_read` | Read one record by id |
| `memory_remember` | Create a durable record |
| `memory_delete` | Soft-delete one record |

`memory_remember` and `memory_delete` default to approval. Use `write: { policy: "allow" }` only for trusted local agents. Preload should stay small; use pinned procedural records for stable operating guidance and let the Agent search or read other memory on demand.

State capabilities keep their injected tool sets compact:

| Capability | Read access | Write access |
| --- | --- | --- |
| `db()` | `db_schema`, `db_query` | adds policy-gated `db_exec` |
| `kv()` | `kv_read` | adds `kv_edit` |

`db_exec` requires a rationale and defaults to approval. Trusted local databases can opt out explicitly with `db({ access: "schema", policy: "allow" })`.
