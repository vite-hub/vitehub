---
title: Sandbox server API
description: Run Sandbox Definitions from server code and read their results.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `runSandbox` from `@vite-hub/sandbox` | Invoke a discovered Definition by name. Returns a native `Response`. |
| `defineSandbox` from `@vite-hub/sandbox` | Declare a free-form `<path>.sandbox.ts` Definition. |
| `resolveSandboxRunner` from `@vite-hub/sandbox` | Resolve a runner and read its `executionAuthority` before execution. |
| `readRequestPayload`, `readValidatedPayload` from `@vite-hub/sandbox` | Read a request body, then validate it with a Standard Schema or a validation function. |
| `hubSandbox` from `@vite-hub/sandbox/vite` | Register discovery, types, package preparation, and Provider Output. |

Applications that use the `vite-hub` distribution import the same runtime APIs from `vite-hub/sandbox`.

## Run a Sandbox

`runSandbox(name, payload?, options?)` infers its payload type from the default function and returns a native Web `Response`. A zero-argument function accepts an `unknown` payload.

```ts [server/api/release-notes-json.post.ts]
import { runSandbox } from '@vite-hub/sandbox'

export default defineEventHandler(async () => {
  const response = await runSandbox('release-notes', { notes: 'ship it' }, {
    context: { requestId: 'release-notes-42' },
  })
  if (!response.ok)
    throw new Error(await response.text())
  return await response.json()
})
```

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Second argument passed to the entrypoint. |
| `sandboxId` | `string` | Cloudflare only. Reuse a named Box instead of a new Box for each run. |

Payloads, context, and results use JSON serialization. Nested `Blob` and `Uint8Array` values cross the Box boundary through invocation-local Box files, so you do not convert them to base64. Node.js `Buffer` values keep their `Buffer` type.

Failures, including timeouts and cleanup failures, return a non-2xx JSON `Response`. A timed-out attempt returns the `SANDBOX_TIMEOUT` code.
