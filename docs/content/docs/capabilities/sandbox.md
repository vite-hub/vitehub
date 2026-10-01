---
title: Sandbox
description: Let an Agent run allowlisted executables in an isolated sandbox through one sandbox_exec tool.
navigation.title: Sandbox
navigation.order: 100
navigation.group: Runtime primitives
icon: i-lucide-box
---

`sandbox({ commands })` gives an Agent the `sandbox_exec` tool. The tool runs one allowlisted executable with optional args, cwd, environment, and timeout.
It delegates execution to the configured [Sandbox primitive](/docs/server-primitives/sandbox).
The Sandbox primitive page covers application code. This page covers the Agent tool.

## Configure sandbox commands

Pass executable names, not shell command strings. `commands` is required and must contain at least one name.

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

## Agent-visible tool contract

This definition is resolved from the real Capability during the docs build with the example `node` and `pnpm` allowlist above.

::agent-capability-tools{name="sandbox"}
::

The tool reads these input fields: `command` (required), `args`, `cwd`, `env`, and `timeout`. The tool description lists the allowed commands.

## How sandbox execution works

1. When the Agent Definition loads, ViteHub validates `commands`. Each name must match `[A-Za-z0-9_.-]+`. A value such as `'pnpm test'` fails with `accepts executable names only, not shell command strings`.
2. When the Agent Invocation resolves its tools, the Capability reads the configured Sandbox primitive.
3. When the Agent calls `sandbox_exec`, the tool checks that `command` exactly matches one allowlisted name.
4. The tool calls `exec(command, args, { cwd, env, timeout })` on the Sandbox primitive and returns its result unchanged. `args` defaults to `[]`.

Sandbox is not Workspace Shell.
Use [`workspaceShell()`](/docs/capabilities/workspace-shell) for Workspace inspection and structured Workspace mutation.

## Requirements

- An explicit Workspace. Without one, `defineAgent()` fails with `sandbox() requires an explicit workspace.`
- A configured [Sandbox primitive](/docs/server-primitives/sandbox). Without one, tool resolution fails with `Capability "sandbox" requires the sandbox primitive to be configured.`
- The primitive must expose `exec()`. Otherwise each `sandbox_exec` call fails with `Sandbox primitive does not expose exec().`

## Security and approval

- The allowlist checks only the executable name. The Agent controls `args`, `cwd`, `env`, and `timeout`, and the tool passes them to the Sandbox primitive without other checks.
- An allowlisted executable such as `node` or `pnpm` can run any code that its arguments select. The isolation of the Sandbox primitive is the security boundary.
- `sandbox()` has no `policy` option. Calls with an allowlisted command run without approval. To add an approval gate, wrap execution in a [Custom Capability](/docs/capabilities/custom-capabilities) with a tool `policy`.
- A disallowed command fails with `Sandbox command "<name>" is not allowed.` before the Sandbox primitive runs.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `sandbox_exec`. |
| Provider-backed | Receives `sandbox_exec` through the provider MCP bridge. |
| Custom-run-backed | `driver.run` receives `sandbox_exec` in `context.tools` and decides whether to call it. |

## Verify the sandbox

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains `{ name: "sandbox", category: "execution", commands: ["node", "pnpm"] }`.
3. Ask the Agent to run an executable that is not in `commands`. Confirm that the tool fails with `Sandbox command "<name>" is not allowed.` and that the Sandbox primitive did not run.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `string[]` | required | Allowlisted executable names. Pass at least one name. Each name must match `[A-Za-z0-9_.-]+`. |

## Related pages

- [Sandbox primitive](/docs/server-primitives/sandbox)
- [workspaceShell()](/docs/capabilities/workspace-shell)
- [Official capabilities](/docs/capabilities/official-capabilities)
