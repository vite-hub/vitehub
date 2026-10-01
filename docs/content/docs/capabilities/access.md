---
title: Access
description: Admit trusted chat traffic and narrow the Workspace before other Capabilities add tools.
navigation.title: Access
navigation.order: 10
navigation.group: Invocation
icon: i-lucide-shield-check
---

`access()` resolves access when an Agent Invocation starts. It can admit or reject chat messages from Channels, and it can narrow the [Workspace](/docs/server-primitives/workspace) to a Workspace Scope before other Capabilities use it. It adds no model-facing tools.

The Workspace primitive page covers application code. This page covers how an Agent receives a scoped Workspace.

## Configure access

Place `access()` before Workspace and storage Capabilities. The selected scope narrows the Workspace before `workspaceShell()` exposes tools.

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

Select a scope from trusted invocation context:

```ts [server/agents/support.ts]
import { defineAgent } from 'vite-hub/agent'
import { access, workspaceShell } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    access({
      chat: {
        resolve: ({ invoker }) => invoker?.kind !== 'anonymous',
      },
      workspace: {
        defaultScope: 'public',
        resolve: ({ invoker }) => invoker.meta?.team === 'staff'
          ? { scope: 'staff', role: 'admin' }
          : undefined,
        scopes: {
          public: { paths: ['public'] },
          staff: { all: true },
        },
      },
    }),
    workspaceShell({ mode: 'read' }),
  ],
})
```

## How access works

Capabilities run their setup phases in array order, so later Capabilities see the scoped Workspace.

### Workspace Scope

1. ViteHub calls `workspace.resolve`, or uses its static value. When it returns nothing valid, ViteHub uses `defaultScope`. When neither produces a scope, the invocation fails.
2. A selection is a scope name or `{ scope, role, ...grants }`. Inline grants replace the named definition in `scopes`. The role defaults to `"viewer"`.
3. ViteHub resolves path and Source grants to Workspace paths, then replaces the active Workspace with a scoped facade.
4. ViteHub records the scope in invocation context as `access.workspaceScope` with `all`, `paths`, `role`, `scope`, and `sources`.

The scoped facade hides paths outside the scope. Reads, lists, searches, globs, Source materialization, and Workspace Sessions see only the granted paths. A hidden path behaves as not found.

Workspace Sources do not own authorization. Grant a Source by key from each scope that may use it, or grant its concrete Workspace path. Invocation-aware Source Resolution can then narrow the Source repository, root, or mount. Access recalculates a Source grant against that resolved shape before it exposes the scoped Workspace.

For Provider Drivers, paths that other Capabilities materialize, such as Skill directories, stay visible in the scope.

### Chat admission

For each message that an adapter-backed Channel receives, ViteHub calls `chat.resolve` before the Agent Invocation starts. The context includes the resolved `invoker`, the message `input`, the Channel `provider`, the `request`, and the `webhook` registration. When `resolve` returns `false`, ViteHub records the delivery as rejected and does not start the invocation. Any other return value admits the message.

### Instructions

Put model-facing guidance for each scope in Agent Driver Instructions or in an imported instruction file. Wrap guidance that depends on Access in an explicit `::capability{key="access"}` block. Scope definitions do not accept instructions.

## Requirements

- `access()` requires `chat`, `workspace`, or both.
- `access({ workspace })` requires an explicit Workspace on the Agent Definition.
- Model-backed and custom-run-backed Agents require a read-only Workspace. Writable Workspace access is supported only for Provider Agent Drivers, and stays limited to the selected scope.
- Source grants require a Workspace Definition.
- `access({ chat })` must be in the static `capabilities` array, not in a capabilities resolver function.

## Security and approval

`access()` adds no tools and has no `policy` option. It narrows what later Capabilities and Drivers can reach.

- Resolve scopes and chat admission from trusted Agent Invoker or platform identity metadata. Do not treat model text as access authority.
- `all: true` grants the full Workspace and requires `role: 'admin'` in the selection.
- Scope paths must stay inside the Workspace. Absolute paths and `..` segments fail.
- A root-mounted Source grant fails. Grant explicit paths instead.
- `chat.resolve` returns `false` to reject. Returning `undefined` admits the message, so return `false` explicitly for every rejected case.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the read-only scoped Workspace and any explicitly authored Agent instructions. |
| Provider-backed | Receives the scoped Workspace, which can be writable. Model-facing instructions require provider support. |
| Custom-run-backed | Receives the read-only scoped Workspace and the invocation context. `driver.run` decides how to use them. |

## Verify access

1. Run an Agent Invocation with `access()` and inspect its traces or run events for the `access` Capability.
2. Confirm that `access.workspaceScope` appears in invocation context and that Workspace tools cannot read outside the selected paths.
3. Trigger scope failures during development. Confirm that a missing scope, a root-mounted Source grant, a missing Workspace, or a path escape fails before model execution.
4. Send a Channel message that `chat.resolve` rejects and confirm that no Agent Invocation starts.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `chat.resolve` | `(context) => boolean \| void` | none | Admit or reject a Channel message before the Agent Invocation starts. Return `false` to reject. |
| `workspace.defaultScope` | `string` | none | Fallback scope name when `resolve` does not select one. |
| `workspace.resolve` | `string \| selection \| (context) => selection \| undefined` | none | Select a scope from trusted invocation context. |
| `workspace.scopes` | `Record<string, scope>` | none | Named scope definitions. |
| `selection.scope` | `string` | required | Scope name. |
| `selection.role` | `AccessRoleName` | `"viewer"` | Role for the selected scope. Full-Workspace access requires `"admin"`. |
| `scope.all` | `boolean` | `false` | Grant the full Workspace when the selection uses the `"admin"` role. |
| `scope.path` / `scope.paths` | `string \| string[]` | none | Grant Workspace paths. |
| `scope.source` / `scope.sources` | `string \| string[]` | none | Grant Workspace Sources by key. |
| `scope.grants` | `AccessWorkspaceScopeGrant[]` | none | Combine path and Source grants. |

A selection object accepts the same grant fields as a scope definition.

## Related pages

- [Workspace primitive](/docs/server-primitives/workspace)
- [Workspace context](/docs/agents/workspace-context)
- [Channels](/docs/agents/channels)
- [Actors](/docs/agents/actors)
- [workspaceShell()](/docs/capabilities/workspace-shell)
- [Official Capabilities](/docs/capabilities/official-capabilities)
