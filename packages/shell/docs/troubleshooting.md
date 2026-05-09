---
title: Shell troubleshooting
description: Fix rejected commands, path escapes, read-only writes, and unsupported search flags.
navigation.title: Troubleshooting
navigation.order: 4
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when `exec()` returns a non-zero exit code or rejects input.

## Unsupported command

Error:

```txt
Unsupported workspace shell command: rm
```

Cause: the command is not included in `allowedCommands` or `commands`.

Fix: add only the command you intend to expose.

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

Cause: `singleCommand: true` rejected multiple commands, pipes, redirects, or command substitution.

Fix: run one command at a time.

## Path escapes the workspace

Error:

```txt
[vitehub] Workspace path escapes the workspace root: "../README.md".
```

Fix: use workspace-relative paths or `/workspace/...` paths.

```ts
await runtime.exec('cat docs/README.md')
```

## Filesystem is read-only

Cause: a mutation reached `createReadonlyWorkspaceFs()`.

Fix: use `createWritableWorkspaceFs()` only for flows that should write files, and keep command policy explicit.

## Unsupported search flag

Error:

```txt
[vitehub] Unsupported workspace search flag: --files.
```

Fix: use supported `rg` and `grep` flags, or call the workspace API directly.

Supported search flags include `-i`, `--ignore-case`, `-n`, `--line-number`, `-e`, and `--regexp`.
