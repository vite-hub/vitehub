---
title: Workspace shell
description: Expose shell-shaped Workspace inspection and optional structured Workspace mutation tools.
navigation.title: Workspace shell
navigation.order: 50
navigation.group: Workspace
icon: i-lucide-folder-search
---

`workspaceShell()` adds model-facing Workspace tools to an Agent.
It exposes shell-shaped inspection by default and write tools only when the Agent's Workspace grants write mode.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

The Capability contributes Workspace inspection tools in read mode and structured Workspace mutation tools in write mode.
When Workspace Sources expose request descriptors, tool descriptions and generated metadata can describe controlled request access; broader usage guidance belongs in Agent Driver Instructions.

## Configuration

Attach `workspaceShell()` only when the Agent should inspect the Workspace.
Use read mode first, then switch to write mode when product behavior requires mutation.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    workspaceShell({ mode: 'read' }),
  ],
})
```

## Runtime behavior

ViteHub validates Workspace requirements before the Capability resolves tools.
In read mode, the Agent receives inspection tools from the active Workspace facade.
In write mode, the Agent receives writable Workspace tools when the Workspace exposes them.

## Requirements

`workspaceShell()` requires an explicit Workspace.
Write mode requires `workspace.mode: 'write'`.

Workspace Shell is not Sandbox.
It exposes Workspace file operations, while `sandbox()` runs allowlisted executables in an isolated runtime.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives Workspace tools and structured tool contracts. |
| Harness-backed | Uses the scoped Workspace Session path; model-facing Workspace tools are not passed by default. |
| Custom-run-backed | Receives the prepared Workspace facade; `driver.run` decides whether to call Workspace APIs directly. |

## Inspect and verify

Open DevTools and inspect the Agent's tool list.
Read mode should expose inspection tools, and write mode should expose mutation tools only when the Workspace is writable.

Try reading outside an `access()` Workspace Scope when both Capabilities are attached.
The scoped Workspace should hide or reject paths outside the selected grants.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Selects Workspace inspection tools or write-capable Workspace tools. |

## Reference

- [Workspace context](/docs/agents/workspace-context)
- [Workspace primitive](/docs/server-primitives/workspace)
- [sandbox()](/docs/capabilities/sandbox)
- Source: `packages/agent/src/capabilities/workspace-shell.ts`
