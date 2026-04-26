---
title: Workflow runtime API
description: Runtime functions, helper exports, options, and normalized run types exported by @vitehub/workflow.
navigation.title: Runtime API
navigation.order: 4
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Runtime code imports from `@vitehub/workflow`:

```ts
import {
  createWorkflow,
  defineWorkflow,
  deferWorkflow,
  getWorkflowRun,
  readRequestPayload,
  readValidatedPayload,
  runWorkflow,
  validatePayload,
} from '@vitehub/workflow'
```

Vite config imports the plugin from `@vitehub/workflow/vite`:

```ts
import { hubWorkflow } from '@vitehub/workflow/vite'
```

Nitro config imports the module by name:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/workflow/nitro'],
})
```

## `defineWorkflow(handler, options?)`

Defines a discovered workflow.

```ts
export default defineWorkflow<Payload, Result>(async (context) => {
  return { ok: true }
})
```

The handler receives:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string \| undefined` | Run id chosen by the caller or provider. |
| `name` | `string` | Discovered workflow name. |
| `payload` | `TPayload` | Payload passed to `runWorkflow()` or `deferWorkflow()`. |
| `provider` | `'cloudflare' \| 'vercel'` | Active provider. |
| `step` | `unknown` | Provider step object when one is available. |

Options:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Optional definition id reserved for provider adapters. |

## `runWorkflow(name, input?, options?)`

Starts a workflow and returns normalized run metadata.

```ts
const run = await runWorkflow('welcome', {
  email: 'ava@example.com',
})
```

Use an envelope when you need a stable id:

```ts
const run = await runWorkflow('welcome', {
  id: 'welcome-signup-42',
  payload: {
    email: 'ava@example.com',
  },
})
```

Return shape:

```ts
type WorkflowRun<TPayload = unknown, TResult = unknown> = {
  id: string
  provider: 'cloudflare' | 'vercel'
  status: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'
  payload?: TPayload
  result?: TResult
  metadata?: unknown
}
```

Errors:

| Code | When |
| --- | --- |
| `WORKFLOW_DISABLED` | `workflow: false` disables the runtime. |
| `WORKFLOW_DEFINITION_NOT_FOUND` | No discovered workflow matches `name`. |

## `deferWorkflow(name, input?, options?)`

Starts a workflow without awaiting the start promise from the route.

```ts
deferWorkflow('welcome', {
  email: 'ava@example.com',
})

return { ok: true }
```

`deferWorkflow()` uses the active request `waitUntil()` when the runtime exposes it. It logs start failures because there is no returned promise for the caller to handle.

## `getWorkflowRun(name, id)`

Reads normalized status for a workflow run.

```ts
const run = await getWorkflowRun<WelcomePayload, WelcomeResult>('welcome', id)
```

Cloudflare uses the generated Workflow binding when it is available. Vercel returns generated runtime state for runs started by the same deployment process.

## Payload helpers

### `readRequestPayload(request)`

Reads JSON when the request has an `application/json` content type. Other content types return the request text.

```ts
const payload = await readRequestPayload<WelcomePayload>(request)
```

### `validatePayload(payload, schema)`

Validates an already-read payload. The schema may be a parser function, an object with `parse()`, or an object with `safeParse()`.

```ts
const payload = await validatePayload(rawPayload, schema)
```

### `readValidatedPayload(request, schema)`

Reads and validates a Web `Request`.

```ts
const payload = await readValidatedPayload(request, schema)
```

## `createWorkflow(options)`

Returns provider options and exists for symmetry with other ViteHub runtime helpers.

```ts
const workflow = await createWorkflow({
  provider: 'cloudflare',
})
```

## Config options

`workflow` can be configured in Vite or Nitro config:

```ts
workflow: {
  provider: 'cloudflare',
  binding: 'WORKFLOW_WELCOME',
  name: 'workflow--welcome',
}
```

| Field | Type | Description |
| --- | --- | --- |
| `provider` | `'cloudflare' \| 'vercel'` | Explicit provider. Defaults from hosting: Cloudflare hosting selects Cloudflare, everything else selects Vercel. |
| `binding` | `string` | Override the generated Cloudflare binding name used at runtime. |
| `name` | `string` | Override the provider workflow name used by generated output. |

Set `workflow: false` to disable the runtime and generated provider output.

## Helper exports

Provider naming helpers are exported for tests and advanced integrations:

```ts
import {
  getCloudflareWorkflowBindingName,
  getCloudflareWorkflowClassName,
  getCloudflareWorkflowName,
  getVercelWorkflowName,
} from '@vitehub/workflow'
```
