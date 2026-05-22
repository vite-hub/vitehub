---
title: Shell troubleshooting
description: Fix command failures, path escapes, read-only writes, and parser errors.
navigation.title: Troubleshooting
navigation.order: 4
icon: i-lucide-circle-alert
frameworks: [vite, nitro]
---

Use this page when `exec()` returns a non-zero exit code or rejects input.

## Unsupported command

Error:

```txt
bash: rm: command not found
```

Cause: the command is not included in the `commands` exposed by the `just-bash` runtime.

Fix: add only the command you intend to expose.

```ts
import { createShellRuntime } from '@vitehub/shell'
import { createJustBashProvider } from '@vitehub/shell/providers/just-bash'

createShellRuntime({
  provider: createJustBashProvider({
    commands: ['pwd', 'ls', 'cat'],
    fs,
  }),
})
```

## Parser failure

`analyzeShellCommand()` returns a structured failure instead of throwing.

```ts
const result = await analyzeShellCommand('if then')
// { ok: false, parser: 'sh-syntax', error: '...' }
```

Execution still belongs to the selected provider. Do not rewrite shell commands based on parser output.

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

## Command failure

Real shell execution returns the provider's stdout, stderr, and exit code.

```ts
const result = await runtime.exec('cat missing.md')
console.log(result.exitCode, result.stderr)
```
