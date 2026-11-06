---
title: Sandbox limits and errors
description: Know Sandbox timeouts, cancellation, and session reuse on each provider, and check a Sandbox before you ship it to production.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Limits

- One timeout bounds one execution attempt after provider startup, including package preparation, staging, and execution. Queueing, Sandbox startup, and retry delays can make the full `runSandboxTask()` call take longer.
- Pass an `AbortSignal` to `runSandboxTask()` when the caller owns a cancellation boundary. Cancellation stops cancellable provider work and preserves the caller's abort reason. The Definition timeout remains an independent per-attempt limit, and queueing or provider startup can make the full call take longer.
- Vercel closes each Sandbox session after success or failure. Cloudflare creates and closes a unique Sandbox for each run unless you set `sandboxId`.
- A Cloudflare `sandboxId` shares one Sandbox. ViteHub deletes invocation-local files after each attempt, caches prepared projects by digest, and serializes runs with the same ID in one isolate. Separate Worker isolates can still enter the Sandbox at the same time.

## Cleanup failures

`runSandboxTask()` returns a non-2xx response if Cloudflare cannot remove invocation-local files from a Sandbox that stays open after the run, even when the handler succeeds. A failed cleanup can leave those files in a shared Sandbox. When ViteHub closes the Sandbox after the run, closing it removes those files, so ViteHub does not delete them separately. Session cleanup failures also return a non-2xx response.

If execution and cleanup both fail, the response keeps the primary error code and message. Timeouts keep `SANDBOX_TASK_TIMEOUT` and HTTP 504. When you call `resolveSandboxTaskRunner().run()` directly, the thrown error retains both failures in an `AggregateError` in its cause chain. Provider diagnostics remain available through causes. JSON responses omit causes.

## Cloudflare retries

The Cloudflare runtime retries a request only when a second call has the same effect as the first. These are session cleanup, file reads, full file writes, file deletes, file listing, and recursive directory creation. It retries when Cloudflare marks the error `retryable`. When the error has no flag, it retries temporary failures such as a Container that is still starting. It does not retry when Cloudflare marks the Durable Object `overloaded`.

The runtime never retries `session.exec()`, a new process, a file move, or a port exposure. If the response is lost, the command may have run, so a second call can run it twice. The error keeps the Cloudflare flag in `error.data.retryable` and the original error in `error.cause`. Retry the command yourself only when it is safe to run twice.

## Production checks

A Definition name and its payload select work. They are not a permission boundary. Code inside the Sandbox can use the filesystem, environment, network, credentials, and child processes that the provider exposes.

Inspect that authority before execution when your policy depends on it:

```ts [server/sandbox-authority.ts]
import { resolveSandboxTaskRunner } from '@vite-hub/sandbox/task'

const runner = await resolveSandboxTaskRunner('release-notes')
console.log(runner.executionAuthority)
```

Apply provider controls such as Vercel `networkPolicy`. Keep secrets in server environment or provider configuration. Do not treat container execution alone as authorization for untrusted code.

Run `vitehub inspect definitions` to list discovered Sandbox Task Definitions without starting a server.
