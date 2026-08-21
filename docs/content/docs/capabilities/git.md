---
title: Git
description: Give an Agent bounded Git source-history access inside a Workspace Session.
navigation.title: Git
navigation.order: 65
navigation.group: Workspace
icon: i-lucide-git-branch
---

`git()` exposes bounded Git inspection and selected local Workspace Session state changes.
Use it for review, source-history inspection, and local branch selection, not for publishing repository history.

The Agent must use a git-capable Workspace Session.

The Capability adds one model-facing `shell` tool for controlled Git commands.
In write mode, the same tool can also run a narrow set of local Git operations.

## Configure Git access

```ts [server/agents/reviewer.ts]
import { defineAgent } from 'vite-hub/agent'
import { git } from 'vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    git({ mode: 'read' }),
  ],
})
```

## How Git access works

`shell` accepts one `git` command without shell composition.
Read mode allows source-history commands such as `status`, `diff`, `log`, `show`, `grep`, and ref inspection.

Write mode supports only `fetch`, `checkout`, and `switch` on a clean working tree.
It blocks commit, push, reset, rebase, tag, arbitrary remote URLs, shell composition, and path escapes outside the Workspace.
Supported write commands are allowed by default after the developer enables write mode. An explicit policy can require approval or deny them, but it cannot enable blocked commands.

## Requirements

`git()` requires a Workspace primitive that can start a Workspace Session.
The Workspace requirement is write-mode because ViteHub may need session-local Git state even when the exposed tool mode is read-only.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives one controlled Git `shell` tool. |
| Provider-backed | Receives the controlled Git `shell` tool through the provider MCP bridge. |
| Custom-run-backed | Can use the Workspace Session directly and may inspect Capability metadata. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Allows local `fetch`, `checkout`, and `switch` commands through `shell` when set to `"write"`. |
| `maxOutputLength` | `number` | `Infinity` | Maximum stdout/stderr characters returned per command. |
| `policy` | `AgentToolPolicyDecision \| function` | `"allow"` | Policy for write-mode `shell` commands. Read-only Git commands remain allowed. |
| `timeout` | `number` | `60000` | Execution timeout in milliseconds passed to Workspace Session Git commands. |

## Verify Git access

Run `vitehub agent info --agent <name> --json` and inspect the resolved tool list.
Run `git status --short` through `shell`, then verify unsupported commands such as `git push` are rejected.

## Related pages

- [Workspace](/docs/server-primitives/workspace)
- [Workspace shell](/docs/capabilities/workspace-shell)
