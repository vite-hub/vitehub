---
title: Sandbox
description: Let an Agent run allowlisted executables in an isolated sandbox.
navigation.title: Sandbox
navigation.order: 100
navigation.group: Runtime primitives
icon: i-lucide-box
---

`sandbox()` owns sandbox execution for Agents.
Use `commands` only when the Agent needs a model-facing allowlist of executable names.

With `commands`, the Capability contributes `sandbox_exec`.
The tool accepts one configured executable name, optional args, cwd, environment, and timeout, then delegates execution to the Sandbox primitive.

## Choose sandbox commands

Pass executable names, not shell command strings.
The Capability rejects names that are not in the allowlist.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { sandbox } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    sandbox({ commands: ['node', 'pnpm'] }),
  ],
})
```

## How sandbox sessions work

ViteHub validates the command allowlist before the Capability attaches.
At invocation time, `sandbox_exec` checks the requested executable against the allowlist and calls the configured Sandbox primitive.

## Requirements

`sandbox({ commands })` requires an explicit Workspace and a configured `sandbox` primitive.
The `commands` option must contain at least one executable name when present.

Sandbox is not Workspace Shell.
Use `workspaceShell()` for Workspace inspection and structured Workspace mutation.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `sandbox_exec`. |
| Provider-backed | Receives `sandbox_exec` through the private MCP bridge when `commands` are configured. |
| Custom-run-backed | The Sandbox primitive is available through runtime context; `driver.run` decides whether to call it. |

## Verify the sandbox

Run `vitehub agent info --agent <name> --json` and confirm `sandbox_exec` lists only the allowed executables.
Run a disallowed command during development and verify ViteHub rejects it before the Sandbox primitive executes.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `string[]` | required | Allowlisted executable names. Pass at least one executable name, not shell command strings. |

## Related pages

- [Sandbox primitive](/docs/server-primitives/sandbox)
- [workspaceShell()](/docs/capabilities/workspace-shell)
