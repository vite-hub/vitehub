---
title: Sandbox runtime API
description: Reference for defineSandbox, runSandbox, readRequestPayload, and the core Sandbox types.
navigation.title: Runtime API
frameworks: [vite, nitro]
---

Use this page when you need the Sandbox surface area, signatures, or option names. For a guided first run, start with [Quickstart](./quickstart).

## Definition API

### `defineSandbox(handler, options?)`

Each sandbox definition default-exports `defineSandbox()`.

```ts
import { defineSandbox } from '@vitehub/sandbox'

export default defineSandbox(async (payload?: { notes?: string }) => {
  return {
    notes: payload?.notes || '',
  }
}, {
  timeout: 30_000,
})
```

## Execution API

### `runSandbox(name, payload?, options?)`

Use `runSandbox()` to execute one named sandbox.

```ts
import { runSandbox } from '@vitehub/sandbox'

const result = await runSandbox('release-notes', {
  notes: '- Added weekly digest',
})

if (result.isOk()) {
  console.log(result.value.summary)
}
```

`runSandbox()` returns a result object instead of throwing for provider or runtime execution failures.

### `SandboxExecutionOptions`

These options are available as the third argument to `runSandbox()`:

| Option | Description |
| --- | --- |
| `context` | Pass request-scoped or caller-scoped data into the sandbox handler. |
| `sandboxId` | Request a stable sandbox identity when the provider supports sandbox reuse. |

## Request helpers

### `readRequestPayload(event, fallback?)`

Use `readRequestPayload()` in H3 routes to read a JSON payload once with a fallback value.

```ts
import { readRequestPayload } from '@vitehub/sandbox'

const payload = await readRequestPayload(event, { notes: '' })
```

## Result API

### `SandboxRunResult<T>`

`runSandbox()` returns `SandboxRunResult<T>`, which wraps the sandbox return value or a `SandboxError`.

| Method / Field | Description |
| --- | --- |
| `isOk()` | Returns `true` when execution succeeded. |
| `isErr()` | Returns `true` when execution failed. |
| `value` | The sandbox return value. Only read after `isOk()`. |
| `error` | Error details with a message and code. Only read after `isErr()`. |

## Related pages

- [Quickstart](./quickstart)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
