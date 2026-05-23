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

In Nitro, the module auto-imports `defineWorkflow` for discovered workflow definitions and `getWorkflowRun` for read-oriented server code. Invocation helpers such as `runWorkflow`, `deferWorkflow`, and `createWorkflow` stay explicit imports because they start or construct workflow behavior.

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
| `provider` | `'cloudflare' \| 'openworkflow' \| 'vercel'` | Active provider. |
| `step` | `unknown` | Provider step object when one is available. |

Options:

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Optional definition id reserved for provider adapters. |

## `runWorkflow(name, payload?, options?)`

Starts a workflow and returns normalized run metadata.

```ts
const run = await runWorkflow('welcome', { email: 'ava@example.com' })
```

Pass `id` in options when you need a stable run id:

```ts
const run = await runWorkflow('welcome', { email: 'ava@example.com' }, { id: 'welcome-signup-42' })
```

Return shape:

```ts
type WorkflowRun<TPayload = unknown, TResult = unknown> = {
  id: string
  provider: 'cloudflare' | 'openworkflow' | 'vercel'
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

## `deferWorkflow(name, payload?, options?)`

Starts a workflow and returns the start promise. Useful for fire-and-forget routes that still want to surface errors via `waitUntil()`.

```ts
await deferWorkflow('welcome', { email: 'ava@example.com' })
return { ok: true }
```

`deferWorkflow()` uses the active request `waitUntil()` when the runtime exposes it.

## `getWorkflowRun(name, id)`

Reads normalized status for a workflow run.

```ts
const run = await getWorkflowRun<WelcomePayload, WelcomeResult>('welcome', id)
```

Cloudflare uses the generated Workflow binding when it is available. Vercel returns generated runtime state for runs started by the same deployment process. OpenWorkflow reads the configured Postgres backend.

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

Defines an inline workflow and returns a typed handle for starting and observing runs.

```ts
const chatReply = createWorkflow<ChatReplyPayload, ChatReplyResult>({
  name: 'chat-reply',
  handler: async ({ payload }) => {
    return await answerWithContext(payload.text)
  },
  id: ({ payload: { threadId, messageId } }) => `${threadId}:${messageId}`,
})

const run = await chatReply.run(payload)
const result = await chatReply.getRun(run.id)
```

`id` is optional. When provided, it must return a string. Passing `run(payload, { id })` or `defer(payload, { id })` overrides the resolver.

## Config options

`workflow` can be configured in Vite or Nitro config:

```ts
workflow: {
  provider: 'openworkflow',
  postgres: {
    url: process.env.OPENWORKFLOW_POSTGRES_URL,
    namespaceId: 'production',
    schema: 'openworkflow',
  },
  worker: {
    concurrency: 10,
  },
}
```

| Field | Type | Description |
| --- | --- | --- |
| `provider` | `'cloudflare' \| 'openworkflow' \| 'vercel'` | Explicit provider. Defaults from hosting: Cloudflare hosting selects Cloudflare, Nitro node/Docker hosting selects OpenWorkflow, everything else selects Vercel. |
| `binding` | `string` | Override the generated Cloudflare binding name used at runtime. |
| `name` | `string` | Override the provider workflow name used by generated output. |
| `postgres.url` | `string` | OpenWorkflow Postgres URL. Defaults to `OPENWORKFLOW_POSTGRES_URL` or `DATABASE_URL`. |
| `postgres.namespaceId` | `string` | OpenWorkflow namespace. Defaults to `OPENWORKFLOW_NAMESPACE_ID` or `production`. |
| `postgres.schema` | `string` | OpenWorkflow schema. Defaults to `OPENWORKFLOW_SCHEMA` or `openworkflow`. |
| `postgres.runMigrations` | `boolean` | Whether OpenWorkflow should run migrations when connecting. |
| `worker.concurrency` | `number` | OpenWorkflow worker concurrency. |

Set `workflow: false` to disable the runtime and generated provider output.

## OpenWorkflow worker helpers

Docker deployments can start a worker process from the generated registry:

```ts
import workflowRegistry from '#vitehub/workflow/registry'
import { startOpenWorkflowWorker } from '@vitehub/workflow/runtime/openworkflow-worker'

await startOpenWorkflowWorker({
  config: {
    provider: 'openworkflow',
    postgres: { url: process.env.OPENWORKFLOW_POSTGRES_URL },
  },
  registry: workflowRegistry,
})
```

When called inside a Nitro runtime that uses `@vitehub/workflow/nitro`, the helper can use the installed runtime workflow config and registry. Separate Docker worker entrypoints should pass `{ config, registry, concurrency }` explicitly.

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
