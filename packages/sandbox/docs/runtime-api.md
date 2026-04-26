---
title: Sandbox runtime API
description: Reference for Sandbox exports, definition options, execution options, result objects, and validation helpers.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names, signatures, and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Most application code imports from `@vitehub/sandbox`:

```ts
import {
  defineSandbox,
  readRequestPayload,
  readValidatedPayload,
  runSandbox,
  validatePayload,
} from '@vitehub/sandbox'
```

::fw{id="vite:dev vite:build"}
Vite config imports the plugin from `@vitehub/sandbox/vite`:

```ts
import { hubSandbox } from '@vitehub/sandbox/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
})
```
::

## Definition API

### `defineSandbox(handler, options?)`

Default-export `defineSandbox()` from every discovered sandbox definition.

```ts
import { defineSandbox } from '@vitehub/sandbox'

export default defineSandbox(async (payload?: { notes?: string }) => {
  return {
    notes: payload?.notes || '',
  }
}, {
  timeout: 30_000,
  env: {
    NODE_ENV: 'production',
  },
})
```

The handler receives:

| Argument | Type | Description |
| --- | --- | --- |
| `payload` | `TPayload | undefined` | The payload passed to `runSandbox()`. |
| `context` | `Record<string, unknown> | undefined` | Optional execution context from `runSandbox(name, payload, { context })`. |

### `SandboxDefinitionOptions`

These options are portable across providers:

| Option | Type | Description |
| --- | --- | --- |
| `timeout` | `number` | Maximum execution time in milliseconds where the provider supports it. |
| `env` | `Record<string, string>` | Environment variables passed to the sandbox process. |
| `runtime.command` | `string` | Override the command used to launch the bundled sandbox definition. |
| `runtime.args` | `string[]` | Extra arguments for the runtime command. |

::callout{icon="i-lucide-alert-triangle" color="warning"}
Definition options must be static JSON-serializable values. The build step extracts them from the `defineSandbox()` call.
::

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

Pass these options as the third argument:

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Request-scoped or caller-scoped data available as the second handler argument. |
| `sandboxId` | `string` | Request a stable sandbox identity when the provider supports reuse. |

```ts
const result = await runSandbox('release-notes', payload, {
  context: {
    requestId: event.context.requestId,
  },
  sandboxId: 'release-notes-writer',
})
```

## Result API

### `SandboxRunResult<T>`

`runSandbox()` returns `SandboxRunResult<T>`.

| Method / Field | Type | Description |
| --- | --- | --- |
| `isOk()` | `() => boolean` | Returns `true` when execution succeeded. |
| `isErr()` | `() => boolean` | Returns `true` when execution failed. |
| `value` | `T` | The sandbox return value. Read only after `isOk()`. |
| `error` | `SandboxError` | Error details. Read only after `isErr()`. |

```ts
const result = await runSandbox('release-notes', payload)

if (result.isErr()) {
  throw createError({ statusCode: 500, statusMessage: result.error.message })
}

return result.value
```

### `SandboxError`

Provider and execution failures are normalized to `SandboxError`.

Useful fields include:

| Field | Description |
| --- | --- |
| `message` | Human-readable failure message. |
| `code` | Stable error code when available. |
| `provider` | Provider that produced the error when available. |
| `details` | Provider or execution diagnostics when available. |

## Request helpers

### `readRequestPayload(event, fallback?)`

Read a JSON request body once with a fallback value.

```ts
import { readRequestPayload } from '@vitehub/sandbox'

const payload = await readRequestPayload(event, { notes: '' })
```

Use it in H3 routes before calling `runSandbox()`.

## Validation helpers

### `readValidatedPayload(payload, validate, options?)`

Validate an already-read value. The validator can be a Standard Schema compatible validator or a function.

```ts
import { readRequestPayload, readValidatedPayload } from '@vitehub/sandbox'

const body = await readRequestPayload(event, { notes: '' })
const payload = await readValidatedPayload(body, (value) => {
  if (!value || typeof value !== 'object') return false

  return {
    notes: String((value as { notes?: unknown }).notes || ''),
  }
})
```

### `validatePayload`

`validatePayload` is an alias for `readValidatedPayload`.

```ts
import { validatePayload } from '@vitehub/sandbox'

const payload = await validatePayload(body, validator)
```

## Provider config

The top-level config key is `sandbox`.

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    sandbox: {
      provider: 'cloudflare',
      binding: 'SANDBOX',
      sandboxId: 'shared-sandbox',
      sleepAfter: '5m',
      keepAlive: true,
      normalizeId: true,
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    sandbox: {
      provider: 'vercel',
      runtime: 'node22',
      timeout: 30_000,
      cpu: 2,
      ports: [3000],
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    }
    ```
  :::
::
