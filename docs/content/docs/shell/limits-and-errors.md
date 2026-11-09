---
title: Shell limits and errors
description: Shell call budget, background process, and command allowlist limits, and checks before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- After `maxShellCalls` is used up, `exec()` returns a `policy_denied` observation. It does not throw.
- `startProcess()` throws when the provider has no background processes or `maxProcesses` is reached.
- A closed session returns `policy_denied` for `exec()` and throws for `startProcess()`.
- The Just Bash `commands` allowlist also applies to controlled `curl`. A network grant does not turn on `curl` when the list leaves it out. An empty list turns it off.
- Controlled `curl` runs wherever Bash runs a command: in a pipeline, after `&&`, or in `$(...)`. Each call is checked against the visible Source Request descriptors. One denied call marks the whole observation `policy_denied`.
- Just Bash copies the command list when you create it. Later changes to your list do not change its permissions or network access.

## Production checks

Set command, filesystem, network, process, streaming, and timeout access before you run commands. A Shell Network Grant allows only the network access it names.

Use a read-only Workspace filesystem unless the caller must write. Set `maxOutputLength` and `timeout` on every runtime that handles untrusted input.

> [!WARNING]
> Just Bash buffers the full command or Source response, then truncates it. So `maxOutputLength` does not limit memory. Its output boundary reports `unsupported` for limits before buffering.

Use an `AbortSignal` tied to the request or Agent Invocation that owns the command. Providers must pass it to their own work. The Just Bash `curl` path passes it to the Source Request executor and keeps the caller's abort reason.
