---
title: Workflows configuration
description: Set Workflow options, define Workflows, and add a durable Vercel entry.
navigation.title: Configure
navigation.order: 4
icon: i-lucide-sliders-horizontal
---

## Configure the Vite Integration

A file or folder in `server/workflows/` turns on Workflows, so you do not add a `workflow` option. Set `workflow` to an object only to change these options, or `workflow: false` to keep Workflows off:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workflow` | `boolean` or `WorkflowOptions` | off | `true` or an object turns on Workflow discovery and host output. Discovered Agents use the configured driver: OpenWorkflow and Cloudflare Workflows are durable; Vercel runs Agent turns inline. |
| `driver` | `WorkflowDriver` | inferred | `cloudflare`, `vercel`, or `openworkflow`. |
| `binding` | `string` | provider default | Binding name in generated output. |
| `name` | `string` | workflow file name | Provider resource name. |
| `postgres.url` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow Postgres URL. |
| `postgres.schema` | `string` | provider default | OpenWorkflow Postgres schema. |
| `postgres.namespaceId` | `string` | provider default | OpenWorkflow namespace id. |
| `postgres.runMigrations` | `boolean` | provider default | Runs OpenWorkflow Postgres migrations. |
| `sqlite.path` | `WorkflowRuntimeConfigValue` | none | OpenWorkflow SQLite path. |
| `sqlite.namespaceId` | `string` | provider default | OpenWorkflow SQLite namespace id. |
| `sqlite.runMigrations` | `boolean` | provider default | Runs OpenWorkflow SQLite migrations. |
| `worker` | `false` or `{ concurrency }` | started | The OpenWorkflow worker that each Nitro server starts. `false` keeps the server from starting it. |
| `remote` | `boolean` | `false` | Lets `vite dev` keep OpenWorkflow runs in the Postgres of `OPENWORKFLOW_POSTGRES_URL` or the Postgres Default Database. Without it, `vite dev` uses the local SQLite file. Builds ignore it. |
| `worker.concurrency` | `number` | `10` | The number of runs that one worker executes at the same time. Each Agent turn uses two runs. |

Without `driver`, ViteHub picks Cloudflare on Cloudflare, OpenWorkflow on Node or Docker (also in `vite dev` with the `node` host), and Vercel on Vercel. Deno requires an explicit driver or OpenWorkflow storage for builds; development and Agent-only Workflows can run inline. Each Node server starts the OpenWorkflow worker. [Workflow hosts](/docs/workflows/hosts#run-workflows-on-node) tells how it picks storage. Netlify cannot infer a driver, so set `driver` or turn Workflow off there. An explicit `driver` always wins.

## Define a workflow

A Workflow Definition is a file that names long-running work. The file path is the Workflow name: `server/workflows/onboard-user.ts` defines `onboard-user`.

```ts [server/workflows/onboard-user.ts] fragment
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow<{ email: string }>({
  handler: async ({ payload }) => {
    const user = await createUser(payload.email)
    await sendWelcomeEmail(user.email)

    return { userId: user.id }
  },
})
```

Use Workflow Steps only when you need parts that the provider can retry or inspect on their own.

## Workflow Definition options

`defineWorkflow({ handler, ...options })` takes one object with `handler` and these options. It has no `name` option.

| Option | Type | Description |
| --- | --- | --- |
| `native` | `(context: WorkflowProviderContext) => unknown` | Durable entry for Vercel Workflow DevKit. |
| `rootStep` | `boolean` | Wraps the handler in a root Workflow Step when the provider supports steps. `context.sleep()` in a root step throws `WORKFLOW_ROOT_STEP_SLEEP`, and `signal.wait()` throws `WORKFLOW_ROOT_STEP_SIGNAL`. A Vercel build always runs a single file as one root step. A folder Workflow's `index.ts` has no root step, so it can [sleep](/docs/workflows/limits-and-errors#retries-and-sleeps) and [wait for a signal](/docs/workflows/limits-and-errors#wait-for-a-signal). |

The handler gets one object, a `WorkflowExecutionContext`, with `payload`, `name`, `provider`, an optional run `id`, the provider `step` when there is one, `sleep`, `createSignal`, and a `steps` runner. Pass the payload type as the type argument: `defineWorkflow<{ email: string }>({ handler })`. It also types `startWorkflow()` for this Workflow. `steps` has one function per numbered file in the workflow folder, typed from `.vitehub/workflow.d.ts`, and is empty when there are no step files.

### Add a durable Vercel entry

A Vercel build makes a Workflow DevKit entry for a single file and for a folder of numbered steps, so they need no `native`. A folder with an index file needs one: without it, the build stops with `WORKFLOW_VERCEL_INDEX_NOT_NATIVE`. Write `native` when the Workflow runs code between its steps, or to control each step yourself. First [install the Vercel dependencies](/docs/workflows/hosts#install-vercel-dependencies), then add the native entry:

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

export default defineWorkflow<OnboardPayload>({
  handler: async ({ payload }) => {
    const user = await createUser(payload.email)
    await sendWelcomeEmail(user.email)
    return { userId: user.id }
  },
  native: durableOnboard,
})
```

ViteHub transforms `native` when it builds Vercel output. Other providers use the normal handler. `vite dev` does not transform `native`, so the dev server runs the normal handler inline, also with the Vercel provider. Test the durable entry on a Vercel preview deployment. Vercel calls `native` with a `WorkflowProviderContext`, which has no `steps` runner. Put side effects in `use step` functions and make them safe to repeat, because a step can be retried.
