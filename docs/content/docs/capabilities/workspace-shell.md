---
title: Workspace shell
description: Expose shell-shaped Workspace inspection, mutation, and allowlisted Workspace command tools.
navigation.title: Workspace shell
navigation.order: 50
navigation.group: Workspace
icon: i-lucide-folder-search
---

`workspaceShell()` adds model-facing Workspace tools to an Agent.
It exposes shell-shaped inspection by default, write tools when the Agent's Workspace grants write mode, and optional allowlisted commands through the same Capability.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes Workspace inspection tools in read mode and structured Workspace mutation tools in write mode.
When configured with `commands`, it also contributes a `workspace_exec` tool that can run only those executable names or absolute executable paths inside a trusted Workspace Session.
When Workspace Sources expose request descriptors, it also contributes instructions that tell the Agent how to inspect controlled curl access.

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

## Requirements

`workspaceShell()` requires an explicit Workspace.
Write mode requires `workspace.mode: 'write'`.
Configured commands also require `workspace.mode: 'write'`, even when `workspaceShell({ mode: 'read' })`, because command execution uses a trusted Workspace Session.

Workspace Shell is not Sandbox.
It exposes Workspace file operations and optional Workspace-session commands, while `sandbox()` runs allowlisted executables in an isolated runtime.
Keep arbitrary executable execution in `sandbox()` or a domain-specific Capability.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives Workspace tools, optional allowlisted command tools, and optional Source request instructions. |
| Harness-backed | Uses the scoped Workspace Session path; model-facing Workspace tools are not passed by default. |
| Custom-run-backed | Receives the prepared Workspace facade; `driver.run` decides whether to call Workspace APIs directly. |

## Inspect and verify

Open DevTools and inspect the Agent's tool list.
Read mode should expose inspection tools, and write mode should expose mutation tools only when the Workspace is writable.
Agents with configured commands should expose `workspace_exec` with only the configured command names.

Try reading outside an `access()` Workspace Scope when both Capabilities are attached.
The scoped Workspace should hide or reject paths outside the selected grants.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Selects Workspace inspection tools or write-capable Workspace tools. |
| `commands` | `string[]` | - | Optional executable names or absolute executable paths allowed through the `workspace_exec` tool. |
| `timeout` | `number` | - | Optional default timeout in milliseconds for configured command execution. |

## Reference

- [Workspace context](/docs/agents/workspace-context)
- [Workspace primitive](/docs/server-primitives/workspace)
- [sandbox()](/docs/capabilities/sandbox)
- Source: `packages/agent/src/capabilities/workspace-shell.ts`
