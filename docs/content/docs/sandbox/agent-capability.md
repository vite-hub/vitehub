---
title: Sandbox capability
description: Let an Agent run allowed programs in an isolated Sandbox with one sandbox_exec tool.
navigation.title: Agent capability
navigation.order: 6
icon: i-lucide-box
---

The `sandbox({ commands })` Capability (a set of tools for an Agent) adds the `sandbox_exec` tool. The tool runs one allowed program with optional args, cwd, environment, and timeout in the configured [Sandbox primitive](/docs/sandbox). For app code, read the [Sandbox server API](/docs/sandbox/server-api).

## Configure sandbox commands

Pass program names, not shell command strings. `commands` is required and needs at least one name.

```ts [server/agents/support.ts] fragment
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

The docs build reads this from the real Capability, with the `node` and `pnpm` allowlist above.

::agent-capability-tools{name="sandbox"}
::

Input fields: `command` (required), `args`, `cwd`, `env`, and `timeout`. The tool description lists the allowed commands.

## How sandbox execution works

1. When the Agent loads, ViteHub checks `commands`. Each name must match `[A-Za-z0-9_.-]+`. A value such as `'pnpm test'` fails with `accepts executable names only, not shell command strings`.
2. When an Invocation (one Agent run) resolves its tools, the Capability reads the configured Sandbox primitive.
3. When the Agent calls `sandbox_exec`, the tool checks that `command` exactly matches an allowed name.
4. The tool checks the options, then calls `exec(command, args, { cwd, env, timeout, signal })` on the Sandbox primitive. `args` defaults to `[]`. `signal` is the Invocation cancel signal, when there is one.

To read and change Workspace files, use [`workspaceShell()`](/docs/workspace/agent-capability) instead.

## Requirements

- An explicit Workspace. Otherwise `defineAgent()` fails with `sandbox() requires an explicit workspace.`
- A configured [Sandbox primitive](/docs/sandbox). Otherwise tool resolution fails with `Capability "sandbox" requires the sandbox primitive to be configured.`
- A primitive with `exec()`. Otherwise each `sandbox_exec` call fails with `Sandbox primitive does not expose exec().`

## Security and approval

- The allowlist matches the program name exactly. Arguments must be strings, and argument and environment sizes have limits. The provider's `cwd` format passes unchanged. The timeout must be a positive integer up to `2_147_483_647` milliseconds.
- Environment keys must be valid names. `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `LD_*`, and `DYLD_*` are reserved, so a tool call cannot change command lookup or inject a loader. This check runs at execution time and ignores case.
- An allowed program such as `node` or `pnpm` can run any code its arguments select. The Sandbox isolation is the security boundary.
- `sandbox()` has no `policy` option, so allowed commands run without approval. To require approval, wrap execution in a [Custom Capability](/docs/agents/capabilities/custom) with a tool `policy`.
- A command that is not allowed fails with `Sandbox command "<name>" is not allowed.` before the Sandbox primitive runs.

## Driver support

| Agent Driver (what runs the Agent) | Support |
| --- | --- |
| Model-backed | Receives `sandbox_exec`. |
| Provider-backed | Receives `sandbox_exec` through the provider MCP bridge. |
| Custom-run-backed | `driver.run` gets `sandbox_exec` in `context.tools` and decides whether to call it. |

## Verify the sandbox

1. Start the Vite development server.
2. Run `vitehub agent info --agent support --json`. Confirm that `tools` contains `{ name: "sandbox", category: "execution", commands: ["node", "pnpm"] }`.
3. Ask the Agent to run a program that is not in `commands`. Confirm that the tool fails with `Sandbox command "<name>" is not allowed.` and the Sandbox primitive did not run.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `commands` | `string[]` | required | Allowed program names. At least one. Each must match `[A-Za-z0-9_.-]+`. |

## Related pages

- [Sandbox primitive](/docs/sandbox)
- [workspaceShell()](/docs/workspace/agent-capability)
- [Official capabilities](/docs/agents/capabilities/official)
