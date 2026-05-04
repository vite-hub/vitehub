---
title: Shell
description: Run policy-controlled shell commands against ViteHub workspace files or Cloudflare sandbox clients.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-terminal
frameworks: [vite, nitro]
---

`@vitehub/shell` provides shell runtime adapters for ViteHub features that need command execution against a controlled workspace.

Use Shell when an agent or server workflow needs familiar inspection commands such as `ls`, `cat`, `find`, and `rg` without exposing an unrestricted host shell.

```ts
import {
  createReadonlyWorkspaceFs,
  createShellRuntime,
  workspaceMountPoint,
} from '@vitehub/shell'

const runtime = createShellRuntime({
  allowedCommands: ['pwd', 'ls', 'cat', 'rg'],
  commands: ['pwd', 'ls', 'cat', 'rg'],
  cwd: workspaceMountPoint,
  fs: createReadonlyWorkspaceFs(workspace),
  provider: 'just-bash',
  singleCommand: true,
})

const result = await runtime.exec('cat README.md')
```

## What Shell solves

Shell turns workspace APIs into command-oriented runtimes with explicit command policy.

::card-group
  :::card
  ---
  icon: i-lucide-shield-check
  title: Command policy
  ---
  Restrict commands with `allowedCommands` and force single-command execution.
  :::

  :::card
  ---
  icon: i-lucide-folder-lock
  title: Workspace filesystem
  ---
  Mount a ViteHub workspace at `/workspace` through read-only or writable filesystem adapters.
  :::

  :::card
  ---
  icon: i-lucide-search
  title: Inspection helpers
  ---
  Run safe workspace inspection commands and normalize search results through workspace APIs.
  :::

  :::card
  ---
  icon: i-simple-icons-cloudflare
  title: Cloudflare shell clients
  ---
  Adapt Cloudflare sandbox clients to the same `ShellRuntime` interface.
  :::
::

## Runtime providers

`createShellRuntime()` supports two providers:

| Provider | Use case |
| --- | --- |
| `just-bash` | Emulate shell commands against a ViteHub workspace filesystem. |
| `cloudflare-shell` | Delegate command execution to a Cloudflare sandbox-compatible client. |

## Workspace mount

Workspace filesystem adapters expose files under `/workspace`.

```ts
import { workspaceMountPoint } from '@vitehub/shell'

console.log(workspaceMountPoint)
```

Paths are normalized so commands cannot escape the workspace root. Reserved paths such as `.git` and `.vitehub` are rejected.

## Start here

Start with [Quickstart](./quickstart) for a read-only workspace runtime. Use [Usage](./usage) when you need writable files, search behavior, or Cloudflare execution.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Create a read-only shell runtime and run workspace inspection commands.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Configure policies, writable filesystems, search commands, and Cloudflare clients.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, provider options, filesystem adapters, and result shapes.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix unsupported commands, path escapes, read-only writes, and command syntax errors.
  to: ./troubleshooting
  ---
  :::
::
