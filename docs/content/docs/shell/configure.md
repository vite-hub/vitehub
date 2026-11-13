---
title: Shell configuration
description: Choose a Shell provider and set the runtime, session, and exec options that control what commands can run.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Providers

A Shell provider implements `ShellExecutionProvider`. Shell has no Vite plugin and generates no host files.

| Provider | Configure with | Boundary |
| --- | --- | --- |
| Just Bash | `createJustBashProvider({ fs, commands?, cwd?, executionLimits?, executionLimitProfile?, networkGrants? })` | Runs `just-bash` on the filesystem adapter you give it. Network is off unless you pass `networkGrants`. No background or interactive processes. Output callbacks run once, after the command ends. |
| Custom | A `ShellExecutionProvider` object | Implement `boundary`, `exec`, and optional `analyze` and `startProcess`. |

Without `cwd`, Just Bash starts in `/workspace`. A provider `cwd` sets the default directory, and an `exec` `cwd` wins over it. Observations report the directory used, also for controlled curl and timeout results. Set `cwd` when your custom filesystem uses another root.

`executionLimits` and `executionLimitProfile` go to the Just Bash interpreter. They limit work that a timeout cannot stop cheaply: loop iterations, command count, call depth, jq/awk/sed iterations, file traversal, and retained bytes. `executionLimitProfile: "hardened"` picks the stricter Just Bash preset, and `executionLimits` values override it. A resource limit exits with code 126 and names the limit in stderr. A deadline exits with code 124. The provider copies both options when you create it.

```ts fragment
const provider = createJustBashProvider({
  fs,
  executionLimitProfile: "hardened",
  executionLimits: { maxLoopIterations: 10_000, maxCommandCount: 5_000 },
})
```

Controlled `curl` is a Just Bash command that goes through the Source network grant, also in pipelines and substitutions. Interpreter limits apply to its output and deadline. Interpreter deadlines, Shell timeouts, and Shell cancellation abort the signal passed to the Source request, and the Source executor must respect it. `maxOutputLength` cuts the output to that many characters.

> [!WARNING]
> Source responses are buffered before output checks and truncation. The Source executor must limit response bytes or memory while it reads.

Read `runtime.boundary` or `session.boundary` to see what the provider declares: CWD, env, filesystem mount point and write access, network, background and interactive processes, streaming, timeout enforcement, execution model, and output limits. These are declarations for inspection. They do not make an in-process provider an OS isolate. When a provider declares `timeout.enforcedBy: "runtime"`, the runtime enforces the timeout: `exec()` returns `command_timed_out` and aborts the provider signal, and a background process is stopped.

To run Shell calls in another runtime, implement a custom `ShellExecutionProvider`.

## Runtime options

| Option | Type | Description |
| --- | --- | --- |
| `provider` | `ShellExecutionProvider` | Required provider. |
| `policy` | `ShellSessionPolicy` | Default policy for `runtime.exec()` and new sessions. |

`runtime.exec(command, options?)` creates a short session, runs one command, closes the session, and returns a Shell Observation (the command result).

## Session and exec options

| Option | Type | Applies to | Description |
| --- | --- | --- | --- |
| `policy` | `ShellSessionPolicy` | `createSession` | Session policy, merged over the runtime policy. |
| `env` | `Record<string, string>` | `createSession`, `exec` | Command environment. `exec` values win. |
| `maxOutputLength` | `number` | `policy`, `exec` | Character limit (zero or more) for stdout and stderr. When both are set, the lower one applies. |
| `maxShellCalls` | `number` | `policy` | Most `exec()` calls in one session. |
| `maxProcesses` | `number` | `policy` | Most tracked background processes, when the provider supports them. |
| `timeout` | `number` | `policy`, `exec` | Command timeout in milliseconds. When both are set, the lower one applies. |
| `signal` | `AbortSignal` | `exec` | Cancels the command and provider work, such as a controlled Source request. |
| `cwd` | `string` | `exec` | Working directory, when the provider supports CWD. |
| `stdin` | `string` | `exec` | Standard input, when the provider supports it. Just Bash passes it to the script. |
| `onStdout` | `function` | `exec` | Receives stdout. Streaming providers send chunks. |
| `onStderr` | `function` | `exec` | Receives stderr. Streaming providers send chunks. |
