---
title: Shell server API
description: Import Shell APIs, use Shell sessions, analyze commands, and read Shell Observations.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `createShellRuntime` from `@vite-hub/shell` | Create a Shell Runtime from an Execution Provider. |
| `analyzeShellCommand` from `@vite-hub/shell` | Parse a command and return static command facts. |
| `createJustBashProvider` from `@vite-hub/shell/providers/just-bash` | Run Bash-compatible commands in the `just-bash` runtime. |
| `createCloudflareShellProvider` from `@vite-hub/shell/providers/cloudflare` | Adapt a Cloudflare execution client to Shell. |
| `createReadonlyWorkspaceFs`, `createWritableWorkspaceFs`, `workspaceMountPoint` from `@vite-hub/shell/workspace` | Mount Workspace file access into Shell providers at `/workspace`. |
| `runWorkspaceInspectionCommand` from `@vite-hub/shell/workspace` | Run a preflighted read-only Workspace inspection command. |
| `cleanWorkspaceShellPath`, `cleanWorkspaceMutationPath` from `@vite-hub/shell/workspace` | Normalize Workspace paths for shell-facing behavior. |

Shell Runtime, Session, Policy, Boundary, Observation, Provider, process, and Workspace filesystem types are exported from these entrypoints. Applications that use the `vite-hub` distribution can import the same APIs from `vite-hub/shell`, `vite-hub/shell/providers/*`, and `vite-hub/shell/workspace`.

Writable Workspace filesystems keep content unchanged when a move resolves to the same source and destination. Missing sources fail. Moves into descendants fail before changing content.

Workspace filesystem adapters preserve binary output from redirection and `tee`. Their read, write, and append methods honor Just Bash encoding options.

Custom providers can return Shell Processes as class instances. Sessions read the process ID, command, and working directory from the provider handle when inspected. These public metadata fields are readonly. A failed metadata read does not prevent process cleanup.

`createWritableWorkspaceFs(useWorkspace(name, { mode: "write" }).fs)` accepts the public writable Workspace facade directly. Workspace writes can return revision receipts. The Shell adapter waits for each write and returns `void` from `writeFile()` and `appendFile()`.

Writable Workspace filesystems create absent files on append. A read failure for an existing file fails the append before changing its content.

Custom providers can return Shell Observations as class instances. Sessions preserve every declared observation field, including fields exposed through getters.

## Use Shell sessions

A Shell Session keeps policy across repeated commands: call budget, output size, timeouts, and process budget.

```ts [server/tasks/inspect-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'

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

Session policy merges over the runtime policy. `session.startProcess()` starts a tracked background process when the provider supports it. `session.dispose()` stops tracked processes and returns a `session_disposed` observation.

## Analyze commands

Command Analysis reports facts about a command before execution. The caller makes the final policy decision.

```ts [server/tasks/analyze-command.ts]
import { analyzeShellCommand } from '@vite-hub/shell'

const analysis = await analyzeShellCommand('rg TODO src')
// analysis.commands: ['rg'], analysis.hasPipelines: false, analysis.ok: true
```

`analyzeShellCommand(command, options?)` uses `sh-syntax`. It returns `ok`, `parser`, `commands`, an optional `error`, and flags for pipelines, redirects, heredocs, and command substitution. `ShellAnalyzeOptions` accepts `maxInputBytes` and `timeoutMs`.

Analysis is not sandbox enforcement. The Execution Provider and caller policy control what the command can do.

## Shell observation shape

| Field | Type | Description |
| --- | --- | --- |
| `event` | `ShellObservationEvent` | `command_finished`, `command_timed_out`, `policy_denied`, or `session_disposed`. |
| `exitCode` | `number or null` | Provider exit code, or `null` when no process exit happened. Policy denials use `126`. |
| `stdout` | `string` | Captured stdout. |
| `stderr` | `string` | Captured stderr. Policy denials put their message here. |
| `command` | `string` | Command that ran, when available. |
| `cwd` | `string` | Working directory used by the provider, when available. |
| `durationMs` | `number` | Runtime duration, when available. |
| `maxOutputLength` | `number` | Output limit applied by the session, when set. |
| `outputTruncated` | `boolean` | Whether `maxOutputLength` truncated output. |
| `timedOut` | `boolean` | Whether timeout ended command execution. |
| `workspaceGuardrail` | `object` | Workspace inspection feedback: `broad_search`, `missing_path`, `no_match`, or `timeout`. |

## Workspace filesystem

The Workspace filesystem has a virtual root at `/workspace`. Root existence checks return true. On a writable filesystem, recursive directory creation at the root succeeds without changing the Workspace. Creating the root without `recursive` fails because it already exists.
