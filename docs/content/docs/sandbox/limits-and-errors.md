---
title: Sandbox limits and errors
description: Sandbox timeouts, cancellation, and session reuse on each provider, and checks before production.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Limits

- A timeout limits one attempt after the provider starts. It covers package setup, staging, and execution. Queueing, Sandbox startup, and retry delays can make the full `runSandboxTask()` call take longer.
- On Vercel, the Sandbox session gets the task timeout plus 30 seconds. The session clock starts before Sandbox setup, so this extra time lets ViteHub end the run at the task timeout with `SANDBOX_TASK_TIMEOUT`. Keep the task timeout 30 seconds below the Vercel plan maximum.
- To cancel a run, pass an `AbortSignal` to `runSandboxTask()`. Cancellation stops provider work that can stop and keeps your abort reason. The task timeout still applies to each attempt on its own.
- Vercel closes each Sandbox session after success or failure. Cloudflare creates and closes a new Sandbox for each run unless you set `sandboxId`.
- A Cloudflare `sandboxId` shares one Sandbox. ViteHub deletes the run's files after each attempt, caches prepared projects by digest, and runs calls with the same ID one at a time in one isolate. Separate Worker isolates can still enter the Sandbox at the same time.

## SANDBOX_R0165

The runtime cannot send the requested process signal. On Crabbox, pass `SIGTERM` to `kill()`. On Vercel, pass `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGKILL`, `SIGTERM`, `SIGCONT`, `SIGSTOP`, or a signal number. On Cloudflare, pass `SIGALRM`, `SIGHUP`, `SIGINT`, `SIGKILL`, `SIGQUIT`, `SIGTERM`, `SIGUSR1`, `SIGUSR2`, or a signal number.

## Cleanup failures

`runSandboxTask()` returns a non-2xx response when Cloudflare cannot remove the run's files from a Sandbox that stays open, even when the handler succeeds. The files can then stay in a shared Sandbox. When ViteHub closes the Sandbox after the run, closing removes the files. A failed session cleanup also returns a non-2xx response.

If execution and cleanup both fail, the response keeps the first error code and message. Timeouts keep `SANDBOX_TASK_TIMEOUT` and HTTP 504. When you call `resolveSandboxTaskRunner().run()`, the thrown error keeps both failures in an `AggregateError` in its cause chain, with provider details. JSON responses omit causes.

## Cloudflare retries

The Cloudflare runtime retries only requests that are safe to repeat: session cleanup, file reads, full file writes, file deletes, file listing, and recursive directory creation. It retries when Cloudflare marks the error `retryable`. With no flag, it retries temporary failures, such as a Container that is still starting. It does not retry when the Durable Object is `overloaded` or the error has `retryable: false`, even during Container startup.

The runtime does not retry `session.exec()`, a new process, a file move, or a port exposure once the request can reach the Container. If the response is lost, the command may have run, and a retry could run it twice. A Container that is still starting never got the command, so ViteHub retries that case. The error keeps the Cloudflare flag in `error.data.retryable` and the original error in `error.cause`. Retry yourself only when running twice is safe.

## Production checks

A task name and payload select work. They do not limit permissions. Code in the Sandbox can use the filesystem, environment, network, credentials, and child processes that the provider gives it. Inspect that access before execution when your policy needs it:

```ts [server/sandbox-authority.ts]
import { resolveSandboxTaskRunner } from 'vite-hub/sandbox/task'

const runner = await resolveSandboxTaskRunner('release-notes')
console.log(runner.executionAuthority)
```

Use provider controls such as Vercel `networkPolicy`. Keep secrets in the server environment or provider config. A container alone does not make untrusted code safe to run.

Run `vitehub inspect definitions` to list Sandbox Tasks without starting a server.
