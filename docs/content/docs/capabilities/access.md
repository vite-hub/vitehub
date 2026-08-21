---
title: Access
description: Resolve trusted invocation access before other Capabilities add tools or Workspace access.
navigation.title: Access
navigation.order: 10
navigation.group: Invocation
icon: i-lucide-shield-check
---

`access()` adds invocation-time access resolution for chat admission and Workspace Scope.
Attach it first to restrict the Workspace seen by later Capabilities or to admit trusted chat webhooks.

`access()` can resolve chat access and apply read-only Workspace Scope before other Capabilities run.
Workspace scopes can grant paths or Sources and set a role.
Model-facing scope guidance belongs in Agent Driver Instructions or deterministic instruction imports.

## Configure access

Place `access()` before Workspace and storage Capabilities.
The selected scope narrows the Workspace facade before `workspaceShell()` exposes tools.

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { access, workspaceShell } from 'vite-hub/agent/capabilities'

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

## How access works

The Capability records the selected Workspace Scope in invocation context and replaces the active Workspace facade with a scoped facade.
Put model-facing guidance for each Access scope in Agent Driver Instructions or an imported instruction file, and cover the Access Capability with an explicit `::capability{key="access"}` block when that guidance depends on Access.

Workspace Sources do not own authorization. Grant a Source by key from each Access scope that may use it, or grant its concrete Workspace path. Invocation-aware Source Resolution can then narrow the Source's repository, root, or Mount; Access recalculates a Source grant against that resolved shape before exposing the scoped Workspace.

## Requirements

`access({ workspace })` requires an explicit Workspace. Model-backed and custom-run-backed Agents receive a read-only scoped Workspace; writable Workspace access is supported only for Provider Agent Drivers and remains limited to the selected scope.
An admin role is required for an all-Workspace scope.

`access({ chat })` requires a resolver that returns an allow or reject decision for chat traffic.
Use trusted Agent Invoker or platform identity metadata; do not treat model text as access authority.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the scoped Workspace and any explicitly authored Agent instructions. |
| Provider-backed | Receives the scoped Workspace behavior; model-facing instructions require provider support. |
| Custom-run-backed | Receives the prepared context value and scoped Workspace; `driver.run` decides how to use them. |

## Verify access

Run an Agent Invocation that includes `access()` and inspect its traces or run events for the `access` Capability.
Verify that `access.workspaceScope` appears in invocation context and that later Workspace tools cannot read outside the selected paths.

Trigger a scope failure during development.
Confirm that a missing scope, root-mounted Source grant, missing Workspace, or invalid path escape fails before model execution.

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

## Related pages

- [Workspace context](/docs/agents/workspace-context)
- [workspaceShell()](/docs/capabilities/workspace-shell)
