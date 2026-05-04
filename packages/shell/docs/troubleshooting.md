---
title: Shell troubleshooting
description: Fix unsupported commands, path escapes, read-only writes, search flags, and Cloudflare client mismatches.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when a Shell runtime returns a non-zero exit code or rejects a command.

## Unsupported command

Error:

```txt
Unsupported workspace shell command: rm
```

Cause: the command is not included in `allowedCommands` or `commands`.

Fix: add only the command you intend to expose, or choose a safer API for the operation.

```ts
createShellRuntime({
  allowedCommands: ['pwd', 'ls', 'cat'],
  commands: ['pwd', 'ls', 'cat'],
  fs,
  provider: 'just-bash',
})
```

## Unsupported shell syntax

Error:

```txt
Unsupported shell syntax: only a single workspace command is supported.
```

Cause: `singleCommand: true` rejects separators, pipes, redirects, substitutions, and multiline commands.

Fix: run one command at a time. Keep `singleCommand: true` for agent-facing command input.

## Workspace path escapes the root

Error:

```txt
[vitehub] Workspace path escapes the workspace root: "../README.md".
```

Cause: the command references a path outside `/workspace`.

Fix: pass workspace-relative paths or `/workspace/...` paths only.

```ts
await runtime.exec('cat docs/README.md')
```

## Workspace filesystem is read-only

Cause: a mutation was attempted through `createReadonlyWorkspaceFs()`.

Fix: use `createWritableWorkspaceFs()` only for workflows that should write files, and keep command allowlists narrow.

## Search flag is unsupported

Error:

```txt
[vitehub] Unsupported workspace search flag: --files.
```

Cause: `runWorkspaceInspectionCommand()` supports a small `rg` and `grep` subset backed by workspace search.

Fix: use supported flags such as `-i`, `--ignore-case`, `-n`, `--line-number`, `-e`, or `--regexp`, or call the workspace API directly.

## Cloudflare runtime ignores `cwd` or `env`

Cause: the sandbox client reports whether it supports cwd and env through `supports.execCwd` and `supports.execEnv`.

Fix: inspect `runtime.supports` before relying on those options.

```ts
if (runtime.supports.cwd) {
  await runtime.exec('pwd', { cwd: '/workspace' })
}
```
