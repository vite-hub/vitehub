---
title: Shell
description: Run policy-controlled shell commands against workspace files or sandbox clients.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-terminal
frameworks: [vite, nitro]
---

`@vitehub/shell` turns controlled file and sandbox APIs into a shell-shaped runtime.

Use Shell when an agent, workflow, or server route needs command-style inspection without exposing an unrestricted host shell.

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
```

## What Shell owns

::card-group
  :::card
  ---
  icon: i-lucide-shield-check
  title: Command policy
  ---
  Restrict commands and reject multi-command shell syntax.
  :::

  :::card
  ---
  icon: i-lucide-folder-lock
  title: Workspace filesystems
  ---
  Mount a ViteHub workspace under `/workspace` with read-only or writable adapters.
  :::

  :::card
  ---
  icon: i-lucide-terminal
  title: Runtime adapters
  ---
  Use `just-bash` for workspace-backed commands or `cloudflare-shell` for sandbox-backed execution.
  :::
::

## Runtime providers

| Provider | Use |
| --- | --- |
| `just-bash` | Emulate shell commands against a ViteHub workspace filesystem. |
| `cloudflare-shell` | Delegate command execution to a Cloudflare sandbox-compatible client. |

## Start here

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Create a read-only workspace shell runtime.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Configure command policy, path helpers, search, writable files, and sandbox clients.
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
  description: Fix rejected commands, path escapes, read-only writes, and unsupported flags.
  to: ./troubleshooting
  ---
  :::
::
