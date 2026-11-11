---
title: Sandbox server API
description: Run Sandbox Tasks from server code with runSandboxTask() and read each run's result and errors.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `runSandboxTask` from `vite-hub/sandbox/task` | Run a task by name. Returns a native `Response`. |
| `defineSandboxTask` from `vite-hub/sandbox/task` | Declare a free-form `<path>.sandbox-task.ts` task. |
| `resolveSandboxTaskRunner` from `vite-hub/sandbox/task` | Get a runner and read its `executionAuthority` before execution. |
| `readRequestPayload`, `readValidatedPayload` from `vite-hub/sandbox/task` | Read the JSON body of a request event with [Standard Context](/docs/reference/runtime-context#standard-context) properties, then validate it with a Standard Schema or a function. |
| `hubSandboxTask` from `@vite-hub/sandbox/task/vite` | Add discovery, types, package setup, and Provider Output (generated host files). |

With the `vite-hub` package, import the same runtime APIs from `vite-hub/sandbox/task`.

## Run a Sandbox Task

`runSandboxTask(name, payload, options?)` takes its payload type from the default function and returns a native `Response`. The payload is required when the registered handler requires it. Handlers with an optional payload or no parameters can be invoked without a payload. A zero-argument function accepts an `unknown` payload.

```ts [server/api/release-notes-json.post.ts]
import { defineEventHandler } from 'h3'
import { runSandboxTask } from 'vite-hub/sandbox/task'

export default defineEventHandler(async () => {
  const response = await runSandboxTask('release-notes', { notes: 'ship it' }, {
    context: { requestId: 'release-notes-42' },
  })
  if (!response.ok)
    throw new Error(await response.text())
  return await response.json()
})
```

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Second argument of the entry point. Defaults to `{}` when omitted. |
| `signal` | `AbortSignal` | Cancel the run. Keeps your abort reason and stops provider work that can stop. |
| `sandboxId` | `string` | Cloudflare only. Reuse a named Sandbox instead of a new one per run. |

Payloads, context, and results are JSON. Nested `Blob` and `Uint8Array` values travel as files in the Sandbox, so you do not convert them to base64. Node.js `Buffer` values stay `Buffer`.

Failures, including timeouts and cleanup failures, return a non-2xx JSON `Response`. A timed-out attempt has the `SANDBOX_TASK_TIMEOUT` code.
