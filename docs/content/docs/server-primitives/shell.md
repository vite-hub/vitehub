---
title: Shell
description: Run Unix-like commands with configured filesystem, process, network, timeout, and policy access.
navigation.order: 13
navigation.group: Files and execution
icon: i-lucide-terminal
---

Use Shell when server code needs to inspect or change files through Unix-like commands. A Shell Runtime sends each command to an Execution Provider. You choose the commands, files, network access, processes, and timeouts that each provider allows.

Each call returns a structured Shell Observation with the exit code, output, and policy events. Shell works without Agents.

::tip
- [Workspace](/docs/server-primitives/workspace) stores the file tree. Shell can mount it read-only or writable.
- [Source](/docs/server-primitives/source) reads external content. It does not run commands.
- [Sandbox](/docs/server-primitives/sandbox) runs a whole package project in a provider-managed Box. Use it when work needs isolation.
- Shell runs single commands with session policy and command analysis. A Shell boundary describes a provider contract. It is not proof of operating-system isolation.
::

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/shell @vite-hub/workspace
```

### Configure

```ts [server/tasks/search-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

const workspace = useWorkspace('docs')
const shell = createShellRuntime({
  policy: { maxOutputLength: 10_000, timeout: 30_000 },
  provider: createJustBashProvider({
    commands: ['pwd', 'ls', 'cat', 'rg'],
    cwd: workspaceMountPoint,
    fs: createReadonlyWorkspaceFs(workspace.fs),
  }),
})
```

### Start using it

```ts [server/tasks/search-docs.ts]
const observation = await shell.exec('rg auth .', { cwd: workspaceMountPoint })
```

::

The provider controls which commands exist. The Workspace filesystem adapter controls whether writes can happen. This example permits four commands, has no network access, and cannot write.

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

## Providers

Shell providers implement `ShellExecutionProvider`. Shell has provider adapters, not a Vite Integration or Provider Output.

| Provider | Configure with | Boundary |
| --- | --- | --- |
| Just Bash | `createJustBashProvider({ fs, commands?, cwd?, networkGrants? })` | Runs `just-bash` against the filesystem adapter you provide. Network is off unless you pass `networkGrants`. No background or interactive processes. Output callbacks run once after the command ends. |
| Cloudflare | `createCloudflareShellProvider({ sandbox })` | Delegates to a client that exposes `exec(command, args, options)`. The command is split into an executable and arguments, with no shell syntax. CWD and env support come from `sandbox.supports`. Network is reported as `unknown`. Streams output. |
| Custom | A `ShellExecutionProvider` object | Implement `boundary`, `exec`, and optional `analyze` and `startProcess`. |

Read `runtime.boundary` or `session.boundary` to check what the provider declares: CWD, env, filesystem mount point and write access, network, background and interactive processes, streaming, and timeout enforcement.

ViteHub has no adapter for Cloudflare's `@cloudflare/shell` package, which is not a Bash interpreter. `createCloudflareShellProvider()` needs a client with the `exec(command, args, options)` shape above. To translate Shell calls into another runtime, implement a custom `ShellExecutionProvider`.

## Runtime options

| Option | Type | Description |
| --- | --- | --- |
| `provider` | `ShellExecutionProvider` | Required Execution Provider. |
| `policy` | `ShellSessionPolicy` | Default policy for runtime `exec()` calls and new sessions. |

`runtime.exec(command, options?)` creates a short-lived session, runs one command, disposes the session, and returns a Shell Observation.

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

## Session and exec options

| Option | Type | Applies to | Description |
| --- | --- | --- | --- |
| `policy` | `ShellSessionPolicy` | `createSession` | Session policy. Merged over the runtime policy. |
| `env` | `Record<string, string>` | `createSession`, `exec` | Environment for commands. `exec` values override session values. |
| `maxOutputLength` | `number` | `policy` | Truncates stdout and stderr in the Shell Observation. |
| `maxShellCalls` | `number` | `policy` | Limits calls to `exec()` in one session. |
| `maxProcesses` | `number` | `policy` | Limits tracked background processes when a provider supports them. |
| `timeout` | `number` | `policy`, `exec` | Command timeout in milliseconds. `exec` overrides the policy value. |
| `cwd` | `string` | `exec` | Working directory when the provider supports CWD. |
| `stdin` | `string` | `exec` | Standard input when the provider supports it. Just Bash ignores it. |
| `onStdout` | `function` | `exec` | Receives stdout. Streaming providers send chunks. |
| `onStderr` | `function` | `exec` | Receives stderr. Streaming providers send chunks. |

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

## Limits

- `maxShellCalls` returns a `policy_denied` observation after the budget is used. It does not throw.
- `startProcess()` throws when the provider has no background process support or `maxProcesses` is reached.
- A disposed session returns `policy_denied` for `exec()` and throws for `startProcess()`.
- The Just Bash `commands` allowlist also applies to controlled `curl` requests. A network grant does not enable `curl` when the list excludes it. An empty command list disables it.
- The Just Bash provider copies the command list at creation. Later changes to the supplied list do not change its permissions or network boundary.

## Production checks

Configure command, filesystem, network, process, streaming, and timeout access before running commands. A Shell Network Grant permits only the network access it names.

Use a read-only Workspace filesystem unless the caller must write. Set `maxOutputLength` and `timeout` for every runtime that handles untrusted input.

## Connect Shell to Agents

Agents use Shell through the [`workspaceShell()` Capability](/docs/capabilities/workspace-shell). It exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools through Workspace Scope, Workspace rules, and Shell policy.

To let an Agent run commands, use the same Capability. `workspaceShell({ mode: 'write', commands: ['pnpm'] })` gives Provider Drivers allowlisted command tools that run in the active Workspace Session. `commands` requires `mode: 'write'` and works only with Provider Drivers. For model-backed Agents, use the [`sandbox()` Capability](/docs/capabilities/sandbox).

Do not expose a raw Shell Runtime to a model. Use [Official capabilities](/docs/capabilities/official-capabilities) so policy, metadata, Driver support, and tools stay attached to the Agent Definition.

## Next steps

- Understand the model-facing [Workspace shell](/docs/capabilities/workspace-shell) tools.
- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Use [Sandbox](/docs/server-primitives/sandbox) for provider-managed isolation.
- Expose Workspace commands to Agents with [Workspace shell](/docs/capabilities/workspace-shell).
