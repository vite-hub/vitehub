---
title: Sandbox limits and errors
description: Sandbox timeouts, Box reuse, and production checks.
navigation.title: Limits and errors
navigation.order: 8
icon: i-lucide-circle-alert
---

## Limits

- One timeout bounds one execution attempt after provider startup, including package preparation, staging, and execution. Queueing, Box startup, and retry delays can make the full `runSandbox()` call take longer.
- Callers cannot pass an `AbortSignal` to `runSandbox()`. A disconnected request does not cancel the run. Set a Definition timeout.
- Vercel closes each Box session after success or failure. Cloudflare creates and closes a unique Box for each run unless you set `sandboxId`.
- A Cloudflare `sandboxId` shares one Box. ViteHub deletes invocation-local files after each attempt, caches prepared projects by digest, and serializes runs with the same ID in one isolate. Separate Worker isolates can still enter the Box at the same time.

## Production checks

A Definition name and its payload select work. They are not a permission boundary. Code inside the Box can use the filesystem, environment, network, credentials, and child processes that the provider exposes.

Inspect that authority before execution when your policy depends on it:

```ts [server/sandbox-authority.ts]
import { resolveSandboxRunner } from '@vite-hub/sandbox'

const runner = await resolveSandboxRunner('release-notes')
console.log(runner.executionAuthority)
```

Apply provider controls such as Vercel `networkPolicy`. Keep secrets in server environment or provider configuration. Do not treat container execution alone as authorization for untrusted code.

Run `vitehub inspect definitions` to list discovered Sandbox Definitions without starting a server.
