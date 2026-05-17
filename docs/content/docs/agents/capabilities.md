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

Official capabilities currently include `skills()`, `voiceInput()`, `mcp()`, `db()`, `kv()`, and `blob()`.
