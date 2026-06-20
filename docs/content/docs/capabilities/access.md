---
title: access()
description: Resolve trusted invocation access before other Capabilities expose scoped runtime surfaces.
navigation.title: access()
navigation.order: 10
icon: i-lucide-shield-check
---

`access()` adds invocation-time access resolution for chat admission and Workspace Scope.
Attach it first when later Capabilities should see a narrowed Workspace or when chat webhooks need an allow-only decision.

## What it adds

`access()` can resolve chat access and apply read-only Workspace Scope before other Capabilities run.
Workspace scopes can grant paths or Sources, set a role, and add explicit Workspace Scope Instructions for the Agent.

## Minimum attach example

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
If the scope includes instructions, ViteHub adds them as the `capabilities.access.workspace` instruction block.

## Requirements

`access({ workspace })` requires an explicit Workspace and currently applies read-only Workspace Scope.
An admin role is required for an all-Workspace scope.

`access({ chat })` requires a resolver that returns an allow or reject decision for the chat surface.
Use trusted Agent Invoker or platform identity metadata; do not treat model text as access authority.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives the scoped Workspace and any Workspace Scope Instructions rendered by the Agent instructions. |
| Harness-backed | Receives the scoped Workspace behavior; model-facing instructions are not passed unless a harness-compatible surface supports them. |
| Custom-run-backed | Receives the prepared context value and scoped Workspace; `driver.run` decides how to use them. |

## Inspect and verify

Run an Agent Invocation that includes `access()` and inspect DevTools for the `access` Capability.
Verify that `access.workspaceScope` appears in invocation context and that later Workspace tools cannot read outside the selected paths.

Trigger a scope failure during development.
Unknown scopes, root-mounted Source grants, missing Workspace definitions, and invalid path escapes should fail before model execution.

## Reference

- [Workspace context](/docs/agents/workspace-context)
- [workspaceShell()](/docs/capabilities/workspace-shell)
- Source: `packages/agent/src/capabilities/access.ts`
