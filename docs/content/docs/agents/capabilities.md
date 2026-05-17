---
title: Capabilities
description: Add agent abilities with composable ViteHub capabilities.
---

Capabilities are agent-scoped plugins for ViteHub agents. They can contribute instructions, tools, input transforms, preparation work, and cleanup behavior without moving storage configuration out of the workspace.

```ts
import { defineAgent } from "@vitehub/agent"
import {
  blob,
  db,
  inputCommands,
  kv,
  mcp,
  skills,
  voiceInput,
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
    voiceInput({ transcribe: async audio => "..." }),
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
        docs: { transport: "http", url: "https://example.com/mcp" },
      },
    }),
    db({ access: "read" }),
    kv({ access: "write" }),
    blob({ access: "read" }),
  ],
})
```

Instruction blocks can be placed with `{{ capabilityId }}` slots. `{{ capabilities }}` inserts any blocks that have not already been placed, and remaining blocks are appended in capability order.

Official capabilities currently include `skills()`, `voiceInput()`, `inputCommands()`, `mcp()`, `db()`, `kv()`, and `blob()`.

`inputCommands()` transforms command-style input before the model runs. Registered slash commands such as `/summarize last week` can return a replacement string or an `AgentRunInput` patch. Unknown slash commands pass through as normal user input. Input commands do not inject system instructions.

Storage capabilities keep their injected tool sets compact:

| Capability | Read access | Write access |
| --- | --- | --- |
| `db()` | `db_schema`, `db_query` | adds policy-gated `db_exec` |
| `kv()` | `kv_read` | adds `kv_edit` |
| `blob()` | `blob_read` | adds `blob_edit` |

`db_exec` requires a rationale and defaults to approval. Trusted local databases can opt out explicitly with `db({ access: "schema", policy: "allow" })`. `blob_edit` writes text, JSON, or base64 media content with a `mediaType`, so future image and audio capabilities can write artifacts through the same storage capability.
