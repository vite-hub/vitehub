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

## Installation

Import the Capability factory from `@vite-hub/agent/capabilities` and add it to `defineAgent({ capabilities })`.
The Agent must use a git-capable Workspace Session.

## What it adds

The Capability adds `git_read` in read mode.
In write mode it also adds `git_write` for a narrow set of local git operations.

## Configuration

```ts [server/agents/reviewer.ts]
import { defineAgent } from '@vite-hub/agent'
import { git } from '@vite-hub/agent/capabilities'

export default defineAgent({
  driver: { model },
  workspace,
  capabilities: [
    git({ mode: 'read' }),
  ],
})
```

## Runtime behavior

`git_read` accepts one `git` command without shell composition.
Read mode allows source-history commands such as `status`, `diff`, `log`, `show`, `grep`, and ref inspection.

`git_write` supports only `fetch`, `checkout`, and `switch` on a clean working tree.
It blocks commit, push, reset, rebase, tag, arbitrary remote URLs, shell composition, and path escapes outside the Workspace.

## Requirements

`git()` requires a Workspace primitive that can start a Workspace Session.
The Workspace requirement is write-mode because ViteHub may need session-local Git state even when the exposed tool mode is read-only.

## Driver support

| Agent Driver | Support |
| --- | --- |
| Model-backed | Receives `git_read`, plus `git_write` in write mode. |
| Harness-backed | Does not receive model-facing Git tools by default. |
| Custom-run-backed | Can use the Workspace Session directly and may inspect Capability metadata. |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `"read" \| "write"` | `"read"` | Adds `git_write` when set to `"write"`. |
| `maxOutputLength` | `number` | `30000` | Maximum stdout/stderr characters returned per command. |
| `policy` | `AgentToolPolicyDecision \| function` | `"require-approval"` | Policy for `git_write`. |
| `timeout` | `number` | none | Execution timeout passed to Workspace Session git commands. |

## Inspect and verify

Inspect the Agent tool list in DevTools.
Run `git status --short` through `git_read`, then verify unsupported commands such as `git push` are rejected.

## Reference

- [Workspace](/docs/server-primitives/workspace)
- [Workspace shell](/docs/capabilities/workspace-shell)
- Source: `packages/agent/src/capabilities/git.ts`
