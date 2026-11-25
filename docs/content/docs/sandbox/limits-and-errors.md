---
title: Sandbox limits and errors
description: Sandbox timeouts, cancellation, and session reuse on each provider, and checks before production.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Timeouts

- A timeout limits one attempt after the provider starts. It covers package setup, staging, and execution. Queueing, Sandbox startup, and retry delays can make the full `runSandboxTask()` call take longer.
- A task without a `timeout` stops after 5 minutes (`300_000` milliseconds) on Vercel and on Cloudflare.
- A run that reaches its timeout returns HTTP 504 with `SANDBOX_TASK_TIMEOUT` on every provider.
- On Vercel, the Sandbox session gets the task timeout plus 30 seconds. The session clock starts before Sandbox setup, so this extra time lets ViteHub end the run at the task timeout.

| Provider | Default | Maximum task timeout |
| --- | --- | --- |
| Vercel Hobby | 5 minutes | 44 minutes 30 seconds (the 45 minute plan limit minus 30 seconds) |
| Vercel Pro and Enterprise | 5 minutes | 23 hours 59 minutes 30 seconds (the 24 hour plan limit minus 30 seconds) |
| Cloudflare | 5 minutes | `2_147_483_647` milliseconds |

## Limits

- To cancel a run, pass an `AbortSignal` to `runSandboxTask()`. Cancellation stops provider work that can stop and keeps your abort reason. The task timeout still applies to each attempt on its own.
- The payload, context, and result of a run have size and depth limits. A run that exceeds one fails with `SANDBOX_TASK_TRANSFER_LIMIT` in `error.data.code`. To change the limits, set [`transfer`](/docs/sandbox/configure#transfer-limits) on the Definition.
- Vercel closes each Sandbox session after success or failure. Cloudflare creates and closes a new Sandbox for each run unless you set `sandboxId`.
- A Cloudflare `sandboxId` shares one Sandbox. ViteHub deletes the run's files after each attempt, caches prepared projects by digest, and runs calls with the same ID one at a time in one isolate. Separate Worker isolates can still enter the Sandbox at the same time.
- ViteHub does not stop a shared Sandbox. After a success, a failure, a timeout, or an abort, the Sandbox stays until it is idle for `sleepAfter`. A timeout or an abort stops only the command of that run, so other runs in the Sandbox continue. A new run does not delete the files that other runs keep in `HOME` or `/workspace`.

## SANDBOX_R0165

The runtime cannot send the requested process signal. On Crabbox, pass `SIGTERM` to `kill()`. On Vercel, pass `SIGHUP`, `SIGINT`, `SIGQUIT`, `SIGKILL`, `SIGTERM`, `SIGCONT`, `SIGSTOP`, or a signal number. On Cloudflare, pass `SIGALRM`, `SIGHUP`, `SIGINT`, `SIGKILL`, `SIGQUIT`, `SIGTERM`, `SIGUSR1`, `SIGUSR2`, or a signal number.

## Cleanup failures

`runSandboxTask()` returns an error when Cloudflare cannot remove the run's files from a Sandbox that stays open, even when the handler succeeds. The files can then stay in a shared Sandbox. When ViteHub closes the Sandbox after the run, closing removes the files. A failed session cleanup also returns an error.

If execution and cleanup both fail, `error.cause` keeps the first error code and message, and both failures in an `AggregateError` in its own cause chain, with provider details. Timeouts keep `SANDBOX_TASK_TIMEOUT` in `error.data.code` and status 504. `resolveSandboxTaskRunner().run()` throws the same error that `error.cause` holds.

## Error responses

A failed `runSandboxTask()` returns `SANDBOX_TASK_RUN_FAILED`. `error.data` has the task `name` and the `code` of the failure, such as `SANDBOX_TASK_HANDLER_ERROR` or `SANDBOX_TASK_TIMEOUT`. `error.status` is 504 for a timeout and defaults to 500 for other failures, including an unknown task name or validation that throws inside a handler.

`return toResponse(error)` sends only `code`, `why`, and `fix`, with that status. `error.cause` has the message and every detail, such as `stack`, `stdout`, `stderr`, and `exitCode`. These fields can hold source paths, environment values, or user data from the Sandbox process. Log `error.cause` on the server. Do not send it to the client.

## Cloudflare retries

The Cloudflare runtime retries only requests that are safe to repeat: session cleanup, file reads, full file writes, file deletes, file listing, and recursive directory creation. It retries when Cloudflare marks the error `retryable`. With no flag, it retries temporary failures, such as a Container that is still starting. It does not retry when the Durable Object is `overloaded` or the error has `retryable: false`, even during Container startup.

The runtime does not retry `session.exec()`, a new process, a file move, or a port exposure once the request can reach the Container. If the response is lost, the command may have run, and a retry could run it twice. A Container that is still starting never got the command, so ViteHub retries that case. The error keeps the Cloudflare flag in `error.data.retryable` and the original error in `error.cause`. Retry yourself only when running twice is safe.

`runSandboxTask()` on Cloudflare follows the same rule for the whole run. A failed run starts again in a new Sandbox only until the package install, the project setup, or the handler command can reach the Container. After a command starts, the Task does not start again. The transport can retry an individual command on a cold start without repeating earlier commands. Handler errors never start the Task again.

## Production checks

A task name and payload select work. They do not limit permissions. Code in the Sandbox can use the filesystem, environment, network, credentials, and child processes that the provider gives it. Inspect that access before execution when your policy needs it:

```ts [server/sandbox-authority.ts]
import { resolveSandboxTaskRunner } from 'vite-hub/sandbox/task'

const runner = await resolveSandboxTaskRunner('release-notes')
console.log(runner.executionAuthority)
```

Set `networkPolicy` to `'deny-all'` or to an allowlist of hostnames to limit outbound traffic on Vercel and Cloudflare. See [Network policy](/docs/sandbox/hosts#network-policy). Keep secrets in the server environment or provider config. A container alone does not make untrusted code safe to run.

Run `vitehub inspect definitions` to list Sandbox Tasks without starting a server.
