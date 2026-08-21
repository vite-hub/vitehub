---
title: Workspace shell
description: Expose scoped Workspace inspection, mutation, and explicit command tools.
navigation.title: Workspace shell
navigation.order: 50
navigation.group: Workspace
icon: i-lucide-folder-search
---

`workspaceShell()` adds Workspace inspection tools in read mode, structured mutation tools in write mode, and an optional `workspace_exec` tool for explicitly configured executables.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model: 'openai/gpt-5.1-mini' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell()],
})
```

Provider Drivers can also expose configured commands in write mode:

```ts [server/agents/coder.ts]
export default defineAgent({
  driver: { kind: 'codex' },
  workspace: { mode: 'write' },
  capabilities: [workspaceShell({ commands: ['git'], mode: 'write', timeout: 30_000 })],
})
```

Command entries accept executable names or absolute paths, never shell command strings. Use `commands: 'all'` only on a trusted host because it permits any executable reachable by the Workspace Session. Successful command changes commit through Workspace rules.

ViteHub validates Workspace requirements before resolving tools. Configured commands require a writable Workspace because every command opens a Workspace Session. Workspace Sources, rules, and Actor Scope bound visible and committed paths, but they do not isolate host side effects outside the Workspace.

Provider Drivers already receive their materialized Workspace as the working directory, so ViteHub avoids duplicate file tools there. Configured `workspace_exec` commands still reach Provider Drivers through the private MCP bridge.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Selects inspection tools or write-capable Workspace tools. |
| `commands` | `string[] \| "all"` | - | Adds a provider-Driver executable allowlist in explicit write mode. |
| `timeout` | `number` | `60000` | Default command timeout in milliseconds. |

Use [`sandbox()`](/docs/capabilities/sandbox) when a model-backed Agent needs an allowlisted executable. Provider Drivers use their native command tools inside the materialized working directory.

## Related pages

- [Workspace context](/docs/agents/workspace-context)
- [Workspace primitive](/docs/server-primitives/workspace)
- [sandbox()](/docs/capabilities/sandbox)
