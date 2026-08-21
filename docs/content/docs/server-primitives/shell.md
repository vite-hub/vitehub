---
title: Shell
description: Run Unix-like commands with configured filesystem, process, network, timeout, and policy access.
navigation.order: 13
icon: i-lucide-terminal
---

Use Shell when server code needs to inspect or change files through Unix-like commands. You choose which commands, files, processes, network access, and timeouts each provider supports.

Shell runs commands through a provider. [Sandbox](/docs/server-primitives/sandbox) can supply an isolated provider, but it doesn't replace Shell's sessions, command analysis, or execution policy.

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
  provider: createJustBashProvider({
    commands: ['pwd', 'ls', 'cat', 'rg'],
    cwd: workspaceMountPoint,
    fs: createReadonlyWorkspaceFs(workspace.fs),
  }),
})
```

### Start using it

```ts [server/tasks/search-docs.ts]
await shell.exec('rg auth docs', { cwd: workspaceMountPoint })
```

::

## Public imports

| Import | Use |
| --- | --- |
| `createShellRuntime` from `@vite-hub/shell` | Create a Shell Runtime from an Execution Provider. |
| `analyzeShellCommand` from `@vite-hub/shell` | Parse a command and return static command facts. |
| `createJustBashProvider` from `@vite-hub/shell/providers/just-bash` | Run Bash-compatible commands in the `just-bash` browser runtime. |
| `createCloudflareShellProvider` from `@vite-hub/shell/providers/cloudflare` | Adapt a Cloudflare execution client to Shell. |
| `createReadonlyWorkspaceFs`, `createWritableWorkspaceFs`, `workspaceMountPoint` from `@vite-hub/shell/workspace` | Mount Workspace file access into Shell providers. |
| `runWorkspaceInspectionCommand` from `@vite-hub/shell/workspace` | Run a preflighted read-only Workspace inspection command. |
| `cleanWorkspaceShellPath`, `cleanWorkspaceMutationPath` from `@vite-hub/shell/workspace` | Normalize Workspace paths for shell-facing behavior. |

Shell Runtime, Session, Policy, Boundary, Observation, Provider, process, and Workspace filesystem types are exported from these entrypoints.

## Providers

Shell providers implement `ShellExecutionProvider`. Shell has provider adapters, not Vite Integration output.

| Provider | Configure with | Boundary nuance |
| --- | --- | --- |
| Just Bash | `createJustBashProvider({ fs, commands?, cwd? })` | Runs `just-bash` against the filesystem adapter you provide. Network is disabled; background and interactive processes are unsupported. |
| Cloudflare | `createCloudflareShellProvider({ sandbox })` | Delegates command execution to a Cloudflare client that exposes `exec(command, args, options)`. CWD and env support come from `sandbox.supports`; network is reported as `unknown`. |
| Custom | A `ShellExecutionProvider` object | Implement `boundary`, `exec`, optional `analyze`, and optional process methods. |

For Cloudflare Workers agents that use Cloudflare's structured shell runtime, install the Cloudflare packages beside ViteHub Shell:

```bash [Terminal]
pnpm add @cloudflare/shell @cloudflare/codemode
```

`@cloudflare/shell` exposes structured `state.*` and Git tools through `@cloudflare/codemode`; it is not a Bash interpreter. Use `createCloudflareShellProvider()` when the Cloudflare runtime provides a command-execution client. Use a custom `ShellExecutionProvider` to translate ViteHub Shell calls into `@cloudflare/shell` state operations.

## Create a Shell runtime

Pass an execution provider to `createShellRuntime()`. The built-in Just Bash provider runs Bash-compatible commands against the filesystem adapter you supply.

```ts [server/tasks/search-docs.ts]
import { createShellRuntime } from '@vite-hub/shell'
import { createJustBashProvider } from '@vite-hub/shell/providers/just-bash'
import { createReadonlyWorkspaceFs, workspaceMountPoint } from '@vite-hub/shell/workspace'
import { useWorkspace } from '@vite-hub/workspace'

export async function searchDocs() {
  const workspace = useWorkspace('docs')
  const runtime = createShellRuntime({
    provider: createJustBashProvider({
      commands: ['pwd', 'ls', 'cat', 'rg'],
      cwd: workspaceMountPoint,
      fs: createReadonlyWorkspaceFs(workspace.fs),
    }),
  })

  return runtime.exec('rg auth docs', {
    cwd: workspaceMountPoint,
  })
}
```

The provider controls available commands. The Workspace filesystem controls whether file writes can happen.

## Runtime options

| Option | Type | Description |
| --- | --- | --- |
| `provider` | `ShellExecutionProvider` | Required execution provider. |
| `policy` | `ShellSessionPolicy` | Default policy applied to runtime `exec()` calls and new sessions. |

`runtime.exec(command, options?)` creates a short-lived session, runs one command, disposes the session, and returns a Shell Observation.

## Use Shell sessions

A Shell Session adds stateful policy around repeated commands, output size, timeouts, and process budget.

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

## Session and exec options

| Option | Type | Applies to | Description |
| --- | --- | --- | --- |
| `env` | `Record<string, string>` | `createSession` | Default environment for session commands. |
| `maxOutputLength` | `number` | `policy` | Truncates Shell Observation output. |
| `maxShellCalls` | `number` | `policy` | Limits calls to `exec()` in one session. |
| `maxProcesses` | `number` | `policy` | Limits tracked background processes when a provider supports them. |
| `timeout` | `number` | `policy`, `exec` | Command timeout in milliseconds. |
| `cwd` | `string` | `exec` | Working directory for the command when the provider supports CWD. |
| `stdin` | `string` | `exec` | Standard input sent to the command. |
| `onStdout` | `function` | `exec` | Receives stdout chunks when the provider supports streaming callbacks. |
| `onStderr` | `function` | `exec` | Receives stderr chunks when the provider supports streaming callbacks. |

## Analyze commands

Command Analysis reports facts about a command before execution. The caller makes the final policy decision.

```ts [server/tasks/analyze-command.ts]
import { analyzeShellCommand } from '@vite-hub/shell'

export async function analyze(command: string) {
  return analyzeShellCommand(command)
}
```

`analyzeShellCommand(command, options?)` uses `sh-syntax` and returns `ok`, parser name, command names, and flags for pipelines, redirects, heredocs, and command substitution. `ShellAnalyzeOptions` accepts `maxInputBytes` and `timeoutMs`.

Don't treat analysis as sandbox enforcement. The execution provider and caller policy control what the command can do.

## Shell observation shape

| Field | Type | Description |
| --- | --- | --- |
| `event` | `ShellObservationEvent` | `command_finished`, `command_timed_out`, `policy_denied`, or `session_disposed`. |
| `exitCode` | `number or null` | Provider exit code, or `null` when no process exit happened. |
| `stdout` | `string` | Captured stdout. |
| `stderr` | `string` | Captured stderr. |
| `command` | `string` | Command that ran, when available. |
| `cwd` | `string` | Working directory used by the provider, when available. |
| `durationMs` | `number` | Runtime duration, when available. |
| `outputTruncated` | `boolean` | Whether `maxOutputLength` truncated output. |
| `timedOut` | `boolean` | Whether timeout ended command execution. |
| `workspaceGuardrail` | `object` | Workspace inspection feedback such as broad search, missing path, no match, or timeout. |

## Connect Shell to Agents

Agents use Shell through Capabilities, usually `workspaceShell()`. That Capability exposes shell-shaped Workspace inspection and optional structured Workspace mutation tools through Workspace Scope, Workspace rules, and Shell policy.

The global Agent `bash` tool is separate from the Shell runtime. Capabilities register executables, and ViteHub sends each structured call through an executable Workspace Session. Read the [Bash concept](/docs/concepts/bash) for the Agent contract.

Don't expose a raw Shell runtime to a model. Use [Official capabilities](/docs/capabilities/official-capabilities) so its policy, metadata, driver support, and tools stay attached to the Agent Definition.

## Production checks

Configure command, filesystem, network, process, streaming, and timeout access before running commands. A Shell Network Grant permits only the network access it names.

Use Sandbox when the app needs provider-managed isolation. Use Shell when the app needs controlled command semantics over a declared Shell Workspace.

## Next steps

- Understand the model-facing [Bash](/docs/concepts/bash) tool.
- Use [Workspace](/docs/server-primitives/workspace) for file-tree state.
- Use [Sandbox](/docs/server-primitives/sandbox) for isolated execution providers.
- Expose command inspection to agents through [Official capabilities](/docs/capabilities/official-capabilities).
