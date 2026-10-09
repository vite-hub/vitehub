---
title: Shell configuration
description: Select a Shell provider and set runtime, session, and exec options.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Providers

Shell providers implement `ShellExecutionProvider`. Shell has provider adapters, not a Vite Integration or Provider Output.

| Provider | Configure with | Boundary |
| --- | --- | --- |
| Just Bash | `createJustBashProvider({ fs, commands?, cwd?, networkGrants? })` | Runs `just-bash` against the filesystem adapter you provide. Network is off unless you pass `networkGrants`. No background or interactive processes. Output callbacks run once after the command ends. |
| Cloudflare | `createCloudflareShellProvider({ sandbox })` | Delegates to a client that exposes `exec(command, args, options)`. The command is split into an executable and arguments, with no shell syntax. CWD and env support come from `sandbox.supports`. Network is reported as `unknown`. Streams output. |
| Custom | A `ShellExecutionProvider` object | Implement `boundary`, `exec`, and optional `analyze` and `startProcess`. |

Just Bash starts in `/workspace` when you omit `cwd`. A provider `cwd` sets the default directory, and an `exec` `cwd` takes precedence. The provider reports the selected directory in its observations, including controlled curl and timeout results. Set `cwd` when your custom filesystem uses another root.

Read `runtime.boundary` or `session.boundary` to check what the provider declares: CWD, env, filesystem mount point and write access, network, background and interactive processes, streaming, and timeout enforcement.

ViteHub has no adapter for Cloudflare's `@cloudflare/shell` package, which is not a Bash interpreter. `createCloudflareShellProvider()` needs a client with the `exec(command, args, options)` shape above. To translate Shell calls into another runtime, implement a custom `ShellExecutionProvider`.

## Runtime options

| Option | Type | Description |
| --- | --- | --- |
| `provider` | `ShellExecutionProvider` | Required Execution Provider. |
| `policy` | `ShellSessionPolicy` | Default policy for runtime `exec()` calls and new sessions. |

`runtime.exec(command, options?)` creates a short-lived session, runs one command, disposes the session, and returns a Shell Observation.

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
