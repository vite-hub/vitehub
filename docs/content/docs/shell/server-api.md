---
title: Shell server API
description: Import Shell APIs, use sessions, analyze commands, and read Shell Observations.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `createShellRuntime` from `vite-hub/shell` | Create a Shell Runtime from a provider. |
| `analyzeShellCommand` from `vite-hub/shell` | Parse a command and return facts about it. |
| `createJustBashProvider` from `vite-hub/shell/providers/just-bash` | Run Bash-compatible commands in the `just-bash` runtime. |
| `createReadonlyWorkspaceFs`, `createWritableWorkspaceFs`, `workspaceMountPoint` from `vite-hub/shell/workspace` | Mount Workspace files in Shell providers at `/workspace`. |
| `runWorkspaceInspectionCommand` from `vite-hub/shell/workspace` | Run a pre-checked, read-only Workspace inspection command. |
| `cleanWorkspaceShellPath`, `cleanWorkspaceMutationPath` from `vite-hub/shell/workspace` | Normalize Workspace paths for shell use. |

These entry points also export the Runtime, Session, Policy, Boundary, Observation, Provider, process, and Workspace filesystem types. With the `vite-hub` package, import the same APIs from `vite-hub/shell`, `vite-hub/shell/providers/*`, and `vite-hub/shell/workspace`.

Workspace filesystem rules:

- A move to the same source and destination changes nothing. A missing source fails. A move into its own descendant fails before content changes.
- Redirection and `tee` keep binary output. Read, write, and append use Just Bash encoding options.
- `createWritableWorkspaceFs(useWorkspace(name, { mode: "write" }).fs)` takes the public writable Workspace directly. Workspace writes can return revision receipts. The adapter waits for each write and returns `void` from `writeFile()` and `appendFile()`.
- Append creates a missing file. If reading an existing file fails, the append fails before content changes.

Custom providers can return Shell Processes and Shell Observations as class instances. Sessions read the process ID, command, and working directory from the provider handle when inspected. These fields are readonly. A failed read does not block process cleanup. Sessions keep every declared observation field, also fields from getters.

`runtime.boundary.execution` gives the execution model (`in_process`, `process`, or `provider_managed`) and `model` (`virtual`, `host`, or `unknown`). `runtime.boundary.resources.output` says whether the provider or the Shell runtime enforces output limits, or whether limits before buffering are unsupported.

## Use Shell sessions

A Shell Session keeps one policy across many commands: call budget, output size, timeouts, and process budget.

```ts [server/tasks/inspect-docs.ts]
import { createShellRuntime } from 'vite-hub/shell'

export async function inspect(runtime: ReturnType<typeof createShellRuntime>) {
  const session = runtime.createSession({
    policy: {
      maxOutputLength: 10_000,
      maxShellCalls: 4,
      timeout: 30_000,
    },
  })

  try {
    return await session.exec('pwd')
  }
  finally {
    await session.dispose()
  }
}
```

Session policy merges over the runtime policy. `session.startProcess()` starts a tracked background process, when the provider supports it. `session.dispose()` stops tracked processes and returns a `session_disposed` observation.

## Analyze commands

Command Analysis reports facts about a command before it runs. You make the final decision.

```ts [server/tasks/analyze-command.ts]
import { analyzeShellCommand } from 'vite-hub/shell'

const analysis = await analyzeShellCommand('rg TODO src')
// analysis.commands: ['rg'], analysis.hasPipelines: false, analysis.ok: true
```

`analyzeShellCommand(command, options?)` uses `sh-syntax`. It returns `ok`, `parser`, `commands`, an optional `error`, and flags for pipelines, redirects, heredocs, and command substitution. `ShellAnalyzeOptions` accepts `maxInputBytes` and `timeoutMs`.

Analysis does not enforce anything. The provider and your policy control what the command can do.

## Shell observation shape

| Field | Type | Description |
| --- | --- | --- |
| `event` | `ShellObservationEvent` | `command_finished`, `command_timed_out`, `policy_denied`, or `session_disposed`. |
| `exitCode` | `number or null` | Provider exit code, or `null` when no process exited. Policy denials use `126`. |
| `stdout` | `string` | Captured stdout. |
| `stderr` | `string` | Captured stderr. Policy denials put their message here. |
| `command` | `string` | Command that ran, when known. |
| `cwd` | `string` | Working directory, when known. |
| `durationMs` | `number` | Duration, when known. |
| `maxOutputLength` | `number` | Session output limit, when set. |
| `outputTruncated` | `boolean` | Whether `maxOutputLength` cut the output. |
| `timedOut` | `boolean` | Whether the timeout ended the command. |
| `workspaceGuardrail` | `object` | Workspace inspection feedback: `broad_search`, `missing_path`, `no_match`, or `timeout`. |

Pass `signal` to `runtime.exec()` or `session.exec()` to cancel provider work. Controlled `curl` passes it to its Source Request executor.

## Workspace filesystem

The Workspace filesystem has a virtual root at `/workspace`, which always exists. On a writable filesystem, a recursive `mkdir` of the root succeeds and changes nothing. Without `recursive`, it fails because the root exists.
