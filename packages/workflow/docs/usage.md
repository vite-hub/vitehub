---
title: Workflow usage
description: Practical patterns for typed payloads, workflow starts, deferred dispatch, stable run ids, and status checks.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

After the quickstart works, most Workflow code falls into four patterns: define a typed flow, start it from request code, choose whether dispatch is awaited or deferred, and check the normalized run later.

## Create explicit workflow handles

Use `createWorkflow(name, handler)` when explicit integration code constructs the workflow handle itself. Framework-discovered workflows should use files or folders; discovery does not scan `createWorkflow()` calls.

```ts
import { createWorkflow } from '@vite-hub/workflow'

type WelcomePayload = {
  email: string
  marker?: string
}

type WelcomeResult = {
  message: string
  marker?: string
}

export const welcomeWorkflow = createWorkflow<WelcomePayload, WelcomeResult>('welcome', async ({ payload }) => {
  return {
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```

## Define discovered workflows

Use discovered workflow files or folders when the workflow should live outside the caller.

::fw{id="vite:dev vite:build"}
```ts [src/welcome.workflow.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export type WelcomeResult = {
  message: string
  marker?: string
}

export default defineWorkflow<WelcomePayload, WelcomeResult>(async ({ payload }) => {
  return {
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export type WelcomeResult = {
  message: string
  marker?: string
}

export default defineWorkflow<WelcomePayload, WelcomeResult>(async ({ payload }) => {
  return {
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```
::

The handler receives a `WorkflowExecutionContext<TPayload>` with `id`, `name`, `payload`, `provider`, and provider-owned step fields.

For multi-step Nitro workflows, create a folder:

```txt
server/workflows/import-products/
  index.ts
  01.extract.ts
  02.transform.ts
```

If `index.ts` is missing, step files run in sorted order and each result is passed to the next step.

## Keep producers provider-neutral

The route should not know whether Cloudflare or Vercel is running the workflow.

```ts
const run = await welcomeWorkflow.run(payload)
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    workflow: {
      provider: 'cloudflare',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    workflow: {
      provider: 'vercel',
    }
    ```
  :::

  :::tabs-item{label="Docker" icon="i-lucide-container" class="p-4"}
    ```ts
    workflow: {
      provider: 'openworkflow',
      postgres: {
        url: process.env.OPENWORKFLOW_POSTGRES_URL,
      },
    }
    ```
  :::
::

## Start with a bare payload

Pass the payload directly when you do not need a custom run id:

```ts
await welcomeWorkflow.run({
  email: 'ava@example.com',
  marker: 'signup-42',
})
```

`runWorkflow()` resolves after the provider accepts the start:

```json
{
  "id": "wrun_lvn4hx4f_x8k2p9s1",
  "provider": "cloudflare",
  "status": "queued"
}
```

## Start with a stable run id

Pass the id in options when the caller needs to persist or poll a known id:

```ts
await welcomeWorkflow.run(payload, { id: 'welcome-signup-42' })
```

When stable identity belongs to the workflow, define it once on the handle:

```ts
const welcomeWorkflow = createWorkflow<WelcomePayload, WelcomeResult>('welcome', async ({ payload }) => {
  return await sendWelcome(payload)
}, {
  id: ({ payload }) => ({
    email: payload?.email,
    marker: payload?.marker,
  }),
})

await welcomeWorkflow.run(payload)
```

## Defer dispatch until after the response

Use `deferWorkflow()` when the route should return immediately and start dispatch can run through the current runtime context:

```ts
import { createWorkflow } from '@vite-hub/workflow'

const welcomeWorkflow = createWorkflow('welcome')

export default defineEventHandler(async () => {
  await welcomeWorkflow.defer({ email: 'ava@example.com', marker: 'signup-42' })
  return { ok: true }
})
```

`deferWorkflow()` returns the start promise and uses `waitUntil()` when the runtime provides it.

## Observe a run

Use the workflow handle with the run id:

```ts
const run = await welcomeWorkflow.getRun(id)

if (run.status === 'completed') {
  console.log(run.result?.message)
}
```

Normalized status values are `queued`, `running`, `completed`, `failed`, and `unknown`.

Provider support differs:

| Provider | Status behavior |
| --- | --- |
| Cloudflare | Reads the Workflow binding when available and normalizes provider status metadata. |
| Vercel | Reports generated runtime state for runs started by the same deployment process. |
| OpenWorkflow | Reads durable run state from the configured Postgres backend. |

## Validate request payloads

Use `readValidatedPayload()` when a Web `Request` should be parsed and validated before starting the workflow:

```ts
import { readValidatedPayload, runWorkflow } from '@vite-hub/workflow'
import { z } from 'zod'

const welcomePayload = z.object({
  email: z.string().email(),
  marker: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const payload = await readValidatedPayload(event.req, welcomePayload)

  return {
    ok: true,
    run: await runWorkflow('welcome', payload),
  }
})
```

`readValidatedPayload()` accepts a parser function, a schema with `parse()`, or a schema with `safeParse()`.

## Workflow naming rules

Workflow names always come from discovered files:

::fw{id="vite:dev vite:build"}
- `src/welcome.workflow.ts` becomes `welcome`
- `src/email/welcome.workflow.ts` becomes `email/welcome`
- `server/workflows/welcome.ts` becomes `welcome`
::

::fw{id="nitro:dev nitro:build"}
- `server/workflows/welcome.ts` becomes `welcome`
- `server/workflows/email/welcome.ts` becomes `email/welcome`
::

## Next steps

- Use [Start a workflow](./guides/start-a-workflow) for full producer examples.
- Use [Observe a run](./guides/observe-a-run) for polling and status handling.
- Use [Validate payloads](./guides/validate-payloads) before starting user-provided workflows.
