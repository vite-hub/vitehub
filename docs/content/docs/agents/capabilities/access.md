---
title: Access
description: Decide who can chat with an Agent, and limit which Workspace files it can see.
navigation.title: Access
navigation.order: 110
navigation.group: Capabilities
icon: i-lucide-shield-check
---

When an Invocation (one Agent run) starts, `access()` accepts or rejects Channel chat messages and limits the [Workspace](/docs/workspace), the Agent's files, to a Workspace Scope. It adds no tools. App code uses the [Workspace server API](/docs/workspace/server-api).

## Configure access

Put `access()` before Workspace and storage Capabilities, so the Workspace is already limited when `workspaceShell()` adds its tools.

```ts [server/agents/support.ts] fragment
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

To choose the scope for each run, read trusted data about the caller:

```ts [server/agents/support.ts] fragment
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

### Workspace Scope

1. ViteHub calls `workspace.resolve`, or uses its static value. If that gives no valid scope, it uses `defaultScope`. If neither does, the Invocation fails.
2. A selection is a scope name or `{ scope, role, ...grants }`. Grants in the selection replace the named definition in `scopes`. The role defaults to `"viewer"`.
3. ViteHub turns path and Source grants into Workspace paths and replaces the active Workspace with a scoped view.
4. ViteHub writes a copy of the scope to the Invocation context as `access.workspaceScope`, with `all`, `paths`, `role`, `scope`, and `sources`.

> [!NOTE]
> ViteHub enforces only the scope that `access()` resolved. Writing to the `access` context key does not change it.

Reads, lists, searches, globs, Source materialization, and Workspace Sessions see only granted paths. Other paths act as not found.

A Workspace Source (a mounted folder or repository) does not decide who can read it. Grant it by key in each scope that can use it, or grant its Workspace path. If Source Resolution then narrows the repository, root, or mount for this Invocation, Access checks the grant again against the result.

For Provider Drivers, paths that other Capabilities add, such as Skill directories, stay visible.

### Chat admission

For each message that an adapter-backed Channel receives, ViteHub calls `chat.resolve` before the Invocation starts. The context has `invoker`, the message `input`, the Channel `provider`, the `request`, and the `webhook` registration. If `resolve` returns `false`, ViteHub records the delivery as rejected and starts no Invocation. Any other value accepts the message.

### Instructions

Write guidance for each scope in the Agent Driver Instructions or an imported instruction file. Wrap guidance that depends on Access in a `::capability{key="access"}` block. Scope definitions do not accept instructions.

## Requirements

- `access()` requires `chat`, `workspace`, or both.
- `access({ workspace })` requires an explicit Workspace on the Agent Definition.
- Model-backed and custom-run-backed Agents require a read-only Workspace. Only Provider Agent Drivers can write, and only inside the selected scope.
- Source grants require a Workspace Definition.
- `access({ chat })` must be in the static `capabilities` array, not a resolver function.

## Security and approval

`access()` has no `policy` option.

- Choose scopes and accept chats from trusted Agent Invoker or platform identity data. Never let model text decide access.
- `all: true` grants the full Workspace and requires `role: 'admin'`.
- Scope paths must stay inside the Workspace. Absolute paths and `..` segments fail.
- A root-mounted Source grant fails. Grant explicit paths.
- Only `false` from `chat.resolve` rejects; `undefined` accepts. Return `false` for every rejected case.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Read-only scoped Workspace and your Agent instructions. |
| Provider-backed | Scoped Workspace, which can be writable. Instructions need provider support. |
| Custom-run-backed | Read-only scoped Workspace and Invocation context, used as `driver.run` decides. |

## Verify access

1. Find the `access` Capability in the run's traces or run events.
2. Check that `access.workspaceScope` is in the Invocation context and that Workspace tools cannot read outside the selected paths.
3. In development, check that each of these fails before the model runs: a missing scope, a root-mounted Source grant, a missing Workspace, and a path outside the Workspace.
4. Send a Channel message that `chat.resolve` rejects, and check that no Invocation starts.

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `chat.resolve` | `(context) => boolean \| void` | none | Accept or reject a Channel message before the Invocation starts. Return `false` to reject. |
| `workspace.defaultScope` | `string` | none | Scope name used when `resolve` selects none. |
| `workspace.resolve` | `string \| selection \| (context) => selection \| undefined` | none | Select a scope from trusted Invocation context. |
| `workspace.scopes` | `Record<string, scope>` | none | Named scope definitions. |
| `selection.scope` | `string` | required | Scope name. |
| `selection.role` | `AccessRoleName` | `"viewer"` | Role for the scope. Full-Workspace access requires `"admin"`. |
| `scope.all` | `boolean` | `false` | Grant the full Workspace when the selection has the `"admin"` role. |
| `scope.path` / `scope.paths` | `string \| string[]` | none | Grant Workspace paths. |
| `scope.source` / `scope.sources` | `string \| string[]` | none | Grant Workspace Sources by key. |
| `scope.grants` | `AccessWorkspaceScopeGrant[]` | none | Combine path and Source grants. |

A selection object accepts the same grant fields as a scope definition.

## Related pages

- [Workspace primitive](/docs/workspace)
- [Workspace context](/docs/agents/workspace-context)
- [Channels](/docs/agents/channels)
- [Trusted Invokers](/docs/agents/trusted-invokers)
- [workspaceShell()](/docs/workspace/agent-capability)
- [Official Capabilities](/docs/agents/capabilities/official)
