---
title: Sandbox runtime API
description: Reference for defineSandbox, runSandbox, readRequestPayload, readValidatedPayload, and the core Sandbox types.
navigation.title: Runtime API
---

Use this page when you need the Sandbox surface area, signatures, or option names. For a guided first run, start with [Quickstart](./quickstart).

## Definition API

### `defineSandbox(handler, options?)`

Each sandbox definition default-exports `defineSandbox()`.

::fw{#vite}
Sandbox definitions live in `src/**/*.sandbox.ts`. The name comes from the relative path with `.sandbox` stripped, so `src/release-notes.sandbox.ts` becomes `release-notes`.
::

::fw{#nitro #nuxt}
Sandbox definitions live in `server/sandboxes/**`. The name comes from the relative path inside that directory.
::

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

`runSandbox()` returns a result object instead of throwing for provider/runtime execution failures.

### `SandboxExecutionOptions`

These options are available as the third argument to `runSandbox()`:

| Option | Description |
| --- | --- |
| `context` | Pass request-scoped or caller-scoped data into the sandbox handler. |
| `sandboxId` | Request a stable sandbox identity when the provider supports sandbox reuse. |

## Validation helpers

Sandbox also exports validation helpers for caller input:

| Helper | Use it for |
| --- | --- |
| `readRequestPayload()` | Read a JSON payload from an H3 request event once, with Cloudflare-safe fallback handling. |
| `readValidatedPayload()` | Validate and normalize input before you execute the sandbox. |
| `validatePayload()` | Alias of `readValidatedPayload()` for explicit imports. |

Use [Validate payloads](./guides/validate-payloads) for examples.

## Result API

### `SandboxRunResult<T>`

`runSandbox()` returns `SandboxRunResult<T>`, which is a result wrapper around the sandbox return value or a `SandboxError`.

| Method / Field | Type | Description |
| --- | --- | --- |
| `isOk()` | `boolean` | `true` when execution succeeded. |
| `isErr()` | `boolean` | `true` when execution failed. |
| `value` | `T` | The sandbox return value. Only safe after `isOk()`. |
| `error` | `SandboxError` | Error details with `message`, `code`, `provider`, and `details`. |

## Core types

### `SandboxDefinitionOptions`

Portable definition options that work across Sandbox providers:

| Option | Description |
| --- | --- |
| `timeout` | Maximum execution time in milliseconds. |
| `env` | Environment variables passed into the sandbox runtime. |
| `runtime` | Override the runtime command with `{ command, args? }`. |

### `SandboxError`

Sandbox failures surface through `result.error` rather than thrown exceptions from `runSandbox()`.

| Field | Description |
| --- | --- |
| `message` | Human-readable failure message. |
| `code` | Provider or runtime error code when available. |
| `provider` | Active sandbox provider. |
| `details` | Extra provider-specific failure data when available. |

## Related pages

- [Quickstart](./quickstart)
- [Run a sandbox](./guides/run-a-sandbox)
- [Validate payloads](./guides/validate-payloads)
- [Reuse a sandbox](./guides/reuse-a-sandbox)
