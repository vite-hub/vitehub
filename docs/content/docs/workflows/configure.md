---
title: Workflows configuration
description: Set Workflow options, define Workflows, and add a durable Vercel entry.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { workflow: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ workflow: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ workflow: true })],
})
```
:::
::

`workflow` takes `true` or an object with these options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workflow` | `boolean` or `WorkflowOptions` | off, or on when `agent` is on | `true` or an object turns on Workflow discovery and host output in `vitehub()`. `false` turns it off. |
| `provider` | `WorkflowProvider` | inferred | `cloudflare`, `vercel`, or `openworkflow`. |
| `binding` | `string` | provider default | Binding name in generated output. |
| `name` | `string` | workflow file name | Provider resource name. |
| `postgres.url` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow Postgres URL. |
| `postgres.schema` | `string` | provider default | OpenWorkflow Postgres schema. |
| `postgres.namespaceId` | `string` | provider default | OpenWorkflow namespace id. |
| `postgres.runMigrations` | `boolean` | provider default | Runs OpenWorkflow Postgres migrations. |
| `sqlite.path` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow SQLite path. |
| `sqlite.namespaceId` | `string` | provider default | OpenWorkflow SQLite namespace id. |
| `sqlite.runMigrations` | `boolean` | provider default | Runs OpenWorkflow SQLite migrations. |
| `worker.concurrency` | `number` | provider default | OpenWorkflow worker concurrency. |

Without `provider`, ViteHub picks Cloudflare on Cloudflare and Vercel on other supported hosts. Netlify cannot infer one, so set `provider` or turn Workflow off there. On Node or Docker, ViteHub picks OpenWorkflow when you set `postgres.url` or `sqlite.path`.

## Define a workflow

A Workflow Definition is a file that names long-running work.

```ts [server/workflows/onboard-user.ts] fragment
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('onboard-user', async (payload: { email: string }) => {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)

  return { userId: user.id }
})
```

Use Workflow Steps only when you need parts that the provider can retry or inspect on their own.

## Workflow Definition options

`defineWorkflow(name, handler, options?)` takes these options. `name` is the discovered file or folder name; another name fails with `WORKFLOW_C0019` when the Workflow loads.

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Static provider id for the workflow. |
| `native` | `(context: WorkflowProviderContext) => unknown` | Durable entry for Vercel Workflow DevKit. |
| `rootStep` | `boolean` | Wraps the handler in a root Workflow Step when the provider supports steps. |

The handler gets `(payload, context)`. Annotate `payload` to type it. `context` is a `WorkflowExecutionContext` with `name`, `payload`, `provider`, an optional run `id`, the provider `step` when there is one, and a `steps` runner. `steps` has one function per numbered file in the workflow folder, typed from `.vitehub/workflow.d.ts`, and is empty when there are no step files.

### Add a durable Vercel entry

Without `native`, Vercel runs the normal handler inline, and the work stops if the function restarts. First [install `@vercel/functions`](/docs/workflows/hosts#install-vercel-dependencies), which all Vercel definitions require. For durable execution on Vercel, also install the Workflow DevKit packages and add a native entry:

```bash pm [Terminal]
pnpm add --save-exact workflow@5.2.3 @workflow/builders@5.0.6
```

```ts [server/workflows/onboard-user.ts] fragment
import { defineWorkflow, type WorkflowProviderContext } from 'vite-hub/workflow'

interface OnboardPayload {
  email: string
}

async function createUserStep(email: string) {
  'use step'

  return await createUser(email)
}

async function sendWelcomeEmailStep(email: string) {
  'use step'

  await sendWelcomeEmail(email)
}

async function durableOnboard({ payload }: WorkflowProviderContext<OnboardPayload>) {
  'use workflow'

  const user = await createUserStep(payload.email)
  await sendWelcomeEmailStep(user.email)
  return { userId: user.id }
}

async function inlineOnboard(payload: OnboardPayload) {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)
  return { userId: user.id }
}

export default defineWorkflow('onboard-user', inlineOnboard, { native: durableOnboard })
```

ViteHub transforms `native` when it builds Vercel output. Other providers use the normal handler. Vercel calls `native` with a `WorkflowProviderContext`, which has no `steps` runner. Put side effects in `use step` functions and make them safe to repeat, because a step can be retried.
