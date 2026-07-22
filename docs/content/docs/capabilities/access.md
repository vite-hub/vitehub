---
title: Access
description: Resolve trusted invocation access before other Capabilities expose scoped runtime surfaces.
navigation.title: Access
navigation.order: 10
navigation.group: Invocation
icon: i-lucide-shield-check
---

`access()` adds invocation-time access resolution for chat admission and Workspace Scope.
Attach it first when later Capabilities should see a narrowed Workspace or when chat webhooks need an allow-only decision.

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
Use the configuration example below as the starting point, then tighten modes, policies, stores, and providers for the Agent boundary.

## What it adds

`access()` can resolve chat access and apply read-only Workspace Scope before other Capabilities run.
Workspace scopes can grant paths or Sources and set a role.
Model-facing scope guidance belongs in Agent Driver Instructions or deterministic instruction imports.

## Configuration

Place `access()` before Workspace and storage Capabilities.
The selected scope narrows the Workspace facade before `workspaceShell()` exposes tools.

```ts [server/agents/support.ts]
import { defineAgent } from '@vite-hub/agent'
import { access, workspaceShell } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    access({
      workspace: {
        defaultScope: 'support',
        scopes: {
          support: { paths: ['support'] },
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
  ],
})
```

## Runtime behavior

The Capability records the selected Workspace Scope in invocation context and replaces the active Workspace facade with a scoped facade.
Put model-facing guidance for each Access scope in Agent Driver Instructions or an imported instruction file, and cover the Access Capability with an explicit `::capability{key="access"}` block when that guidance depends on Access.

Workspace Sources do not own authorization. Grant a Source by key from each Access scope that may use it, or grant its concrete Workspace path. Invocation-aware Source Resolution can then narrow the Source's repository, root, or Mount; Access recalculates a Source grant against that resolved shape before exposing the scoped Workspace.

## Requirements

`access({ workspace })` requires an explicit Workspace. Model-backed and custom-run-backed Agents receive a read-only scoped Workspace; writable Workspace access is supported only for Harness Agent Drivers and remains limited to the selected scope.
An admin role is required for an all-Workspace scope.

`access({ chat })` requires a resolver that returns an allow or reject decision for the chat surface.
Use trusted Agent Invoker or platform identity metadata; do not treat model text as access authority.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the scoped Workspace and any explicitly authored Agent instructions. |
| Harness-backed | Receives the scoped Workspace behavior; model-facing instructions are not passed unless a harness-compatible surface supports them. |
| Custom-run-backed | Receives the prepared context value and scoped Workspace; `driver.run` decides how to use them. |

## Inspect and verify

Run an Agent Invocation that includes `access()` and inspect its traces or run events for the `access` Capability.
Verify that `access.workspaceScope` appears in invocation context and that later Workspace tools cannot read outside the selected paths.

Trigger a scope failure during development.
Missing scope selection, root-mounted Source grants, missing Workspace definitions, and invalid path escapes should fail before model execution.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `chat.resolve` | `(context) => boolean \| void` | none | Allow or reject trusted Chat Platform traffic before the Agent Invocation runs. |
| `workspace.defaultScope` | `string` | none | Fallback Workspace Scope name when `resolve` does not choose one. |
| `workspace.resolve` | `string \| selection \| function` | none | Select a Workspace Scope from trusted invocation context. |
| `workspace.scopes` | `Record<string, scope>` | none | Optional named Workspace Scope definitions for explicit grants or full access. |
| `selection.role` | `AccessRoleName` | `"viewer"` | Role applied to the selected scope. Full-Workspace access requires `"admin"`. |
| `scope.all` | `boolean` | `false` | Grant the full Workspace for that scope when the selection uses the `"admin"` role. |
| `scope.path` / `scope.paths` | `string \| string[]` | none | Grant Workspace paths. |
| `scope.source` / `scope.sources` | `string \| string[]` | none | Grant Workspace Sources. |
| `scope.grants` | `AccessWorkspaceScopeGrant[]` | none | Combine path and Source grants. |

## Reference

- [Workspace context](/docs/agents/workspace-context)
- [workspaceShell()](/docs/capabilities/workspace-shell)
- Source: `packages/agent/src/capabilities/access.ts`
