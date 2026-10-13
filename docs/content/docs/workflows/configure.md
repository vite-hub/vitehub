---
title: Workflows configuration
description: Set Workflow integration options, define Workflows, and add a durable Vercel entry.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubWorkflow()],
})
```

The Vite config key is `workflow`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workflow` | `boolean` or `WorkflowModuleOptions` | disabled, or enabled when `agent` is enabled | Enables Workflow discovery and provider output through `vitehub()` with `true` or an options object; `false` disables it. |
| `provider` | `WorkflowProvider` | inferred | Selects `cloudflare`, `vercel`, or `openworkflow`. |
| `binding` | `string` | provider default | Provider binding name for generated output. |
| `name` | `string` | discovered workflow name | Provider resource name override. |
| `postgres.url` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow Postgres URL. |
| `postgres.schema` | `string` | provider default | OpenWorkflow Postgres schema. |
| `postgres.namespaceId` | `string` | provider default | OpenWorkflow namespace id. |
| `postgres.runMigrations` | `boolean` | provider default | Runs OpenWorkflow storage migrations. |
| `sqlite.path` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow SQLite path. |
| `sqlite.namespaceId` | `string` | provider default | OpenWorkflow SQLite namespace id. |
| `sqlite.runMigrations` | `boolean` | provider default | Runs OpenWorkflow SQLite migrations. |
| `worker.concurrency` | `number` | provider default | OpenWorkflow worker concurrency. |

When no provider is configured, ViteHub selects Cloudflare on Cloudflare hosting and Vercel on other supported hosts. Netlify cannot infer a Workflow Provider, so set `provider` explicitly or disable Workflow there. On Node or Docker hosting, OpenWorkflow is inferred when OpenWorkflow storage is configured through `postgres.url` or `sqlite.path`.

## Define a workflow

Create a Workflow Definition for named long-running work.

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)

  return { userId: user.id }
})
```

Use Workflow Steps only when the selected provider and definition need independently retryable or inspectable units.

## Workflow Definition options

`defineWorkflow(handler, options?)` accepts these options. The discovered file name provides the Definition name.

| Option | Type | Description |
| --- | --- | --- |
| `id` | `string` | Static provider id override for the Workflow Definition. |
| `native` | `WorkflowHandler` | Provider-native durable entry used by Vercel Workflow DevKit. |
| `rootStep` | `boolean` | Wraps the handler in a root Workflow Step when the provider supports steps. |

The handler receives a `WorkflowExecutionContext` with `name`, `payload`, `provider`, optional run `id`, and provider-backed `step` or typed `steps` helpers when available.

### Add a durable Vercel entry

Vercel runs the normal handler inline unless the definition provides `native`.
Inline work does not survive a function restart. Register a Workflow DevKit entry
when the run needs Vercel's durable execution:

```bash [Terminal]
pnpm add workflow @workflow/builders
```

```ts [server/workflows/onboard-user.ts]
import {
  defineWorkflow,
  type WorkflowExecutionContext,
} from '@vite-hub/workflow'

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

async function durableOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  'use workflow'

  const user = await createUserStep(payload.email)
  await sendWelcomeEmailStep(user.email)
  return { userId: user.id }
}

async function inlineOnboard({ payload }: WorkflowExecutionContext<OnboardPayload>) {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)
  return { userId: user.id }
}

export default defineWorkflow(inlineOnboard, { native: durableOnboard })
```

ViteHub transforms the `native` entry when it generates Vercel output. Other
providers keep using the normal handler. Keep external side effects in `use step`
functions and make them idempotent because a step can be retried.
