---
title: Workspace shell
description: Expose Workspace inspection, mutation, and explicit executable tools.
navigation.title: Workspace shell
navigation.order: 50
navigation.group: Workspace
icon: i-lucide-folder-search
---

`workspaceShell()` adds model-facing Workspace tools to an Agent.
It exposes shell-shaped inspection by default, write tools when the Agent's Workspace grants write mode, and optional executable commands through the same Capability.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes Workspace inspection tools in read mode and structured Workspace mutation tools in write mode.
When configured with `commands`, it also contributes a `workspace_exec` tool that can run only those executable names or absolute executable paths inside a trusted Workspace Session.
Set `commands: 'trusted-host'` only when an Agent running on infrastructure you control should be able to select any executable available to the host service account.
When Workspace Sources expose request descriptors, tool descriptions and generated metadata can describe controlled request access; broader usage guidance belongs in Agent Driver Instructions.

## Configuration

Attach `workspaceShell()` only when the Agent should inspect the Workspace.
Use read mode first, then switch to write mode when product behavior requires mutation or committed command results.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    workspaceShell({
      mode: 'read',
      commands: ['git'],
    }),
  ],
})
```

## Runtime behavior

ViteHub validates Workspace requirements before the Capability resolves tools.
In read mode, the Agent receives inspection tools from the active Workspace facade.
In write mode, the Agent receives writable Workspace tools when the Workspace exposes them.
When `commands` is set, ViteHub starts a Workspace Session for each `workspace_exec` call.
Read mode runs the command without committing Workspace changes; write mode commits successful command results back to the Workspace Store.
The mode controls Workspace tools and writeback only. It does not make an executed command read-only or prevent side effects on the host.

## Requirements

`workspaceShell()` requires an explicit Workspace.
Write mode requires `workspace.mode: 'write'`.
Configured commands also require `workspace.mode: 'write'`, even when `workspaceShell({ mode: 'read' })`, because command execution uses a trusted Workspace Session.

Workspace Shell is not Sandbox.
It exposes Workspace file operations and optional Workspace-session commands, while `sandbox()` runs allowlisted executables in an isolated runtime.
Use `sandbox()` for untrusted execution and a domain-specific Capability when the executable set is known.

For a Linux-hosted Agent that intentionally owns its machine or container, configure both unrestricted trusted-host commands and the trusted-host Workspace runtime:

```ts [server/agents/operator.ts]
export default defineAgent({
  capabilities: [
    workspaceShell({ commands: 'trusted-host', mode: 'write' }),
  ],
  driver: { model },
  workspace: {
    mode: 'write',
    runtime: {
      type: 'trusted-host',
      allowProduction: true,
    },
    store,
  },
})
```

Trusted-host commands run as the ViteHub service account and inherit its full process environment. Tools such as `git`, `gh`, and `ssh` therefore use values such as `HOME`, `XDG_CONFIG_HOME`, `GH_CONFIG_DIR`, and `SSH_AUTH_SOCK`; application secrets in the process environment are inherited too.

Workspace rules and Workspace Scope constrain materialization and the diff ViteHub commits back to the Workspace Store. They do not constrain direct host effects through absolute paths or child processes. This is not isolation: the Agent can run `sh`, `gh`, `git`, generated scripts, and any other reachable executable with the service account's filesystem, network, credential, and process authority. Use a dedicated service account or container with narrowly scoped credentials, mounts, and network access.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives Workspace tools, optional allowlisted command tools, and structured tool contracts. |
| Harness-backed | Uses the scoped Workspace Session path; model-facing Workspace tools are not passed by default. |
| Custom-run-backed | Receives the prepared Workspace facade; `driver.run` decides whether to call Workspace APIs directly. |

## Inspect and verify

Open DevTools and inspect the Agent's tool list.
Read mode should expose inspection tools, and write mode should expose mutation tools only when the Workspace is writable.
Agents with a command array should expose `workspace_exec` with only the configured command names.
Trusted-host command mode should expose a free executable field only when the resolved Workspace runtime is trusted-host.

Try reading outside an `access()` Workspace Scope when both Capabilities are attached.
The scoped Workspace should hide or reject paths outside the selected grants.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Selects Workspace inspection tools or write-capable Workspace tools. |
| `commands` | `string[] \| "trusted-host"` | - | Executable allowlist, or explicit unrestricted host execution for a trusted-host Workspace. |
| `timeout` | `number` | - | Optional default timeout in milliseconds for configured command execution. |

## Reference

- [Workspace context](/docs/agents/workspace-context)
- [Workspace primitive](/docs/server-primitives/workspace)
- [sandbox()](/docs/capabilities/sandbox)
- Source: `packages/agent/src/capabilities/workspace-shell.ts`
