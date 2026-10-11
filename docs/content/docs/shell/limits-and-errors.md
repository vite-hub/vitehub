---
title: Shell limits and errors
description: Shell policy limits and production checks.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Limits

- `maxShellCalls` returns a `policy_denied` observation after the budget is used. It does not throw.
- `startProcess()` throws when the provider has no background process support or `maxProcesses` is reached.
- A disposed session returns `policy_denied` for `exec()` and throws for `startProcess()`.
- The Just Bash `commands` allowlist also applies to controlled `curl` requests. A network grant does not enable `curl` when the list excludes it. An empty command list disables it.
- The Just Bash provider copies the command list at creation. Later changes to the supplied list do not change its permissions or network boundary.

## Production checks

Configure command, filesystem, network, process, streaming, and timeout access before running commands. A Shell Network Grant permits only the network access it names.

Use a read-only Workspace filesystem unless the caller must write. Set `maxOutputLength` and `timeout` for every runtime that handles untrusted input.

Just Bash truncates completed output before returning an Observation. It buffers the full command or Source response first, so `maxOutputLength` does not bound execution memory. Its output resource boundary reports `unsupported` for enforcement before buffering.

Use an `AbortSignal` tied to the owning request or Agent Invocation. Shell providers must carry it into provider-owned work; the Just Bash controlled `curl` path forwards it to the Source Request executor and preserves the caller's abort reason.
