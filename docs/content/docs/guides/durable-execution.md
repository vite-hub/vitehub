---
title: What is durable execution? Steps, retries, replay, and idempotency
seo.title: "What is durable execution? Steps, retries, replay"
description: "Durable execution saves the result of each step, so a failed job continues from that step. See an example and what ViteHub Workflows store on each host."
navigation.title: Durable execution
navigation.order: 41
navigation.group: Concepts
icon: i-lucide-history
---

Durable execution means a job saves each step's result outside the process. When a step fails, the engine retries only that step. When the process stops, the engine replays the job: finished steps return their saved result, and the job continues from the unfinished step. A step can still run more than once, so it must be idempotent (safe to repeat). In ViteHub, a Workflow is durable only when its provider stores the steps: Cloudflare Workflows, OpenWorkflow with Postgres or SQLite, or a Vercel `native` entry. Inline runs in `vite dev` and normal Vercel handlers are not.

## How durable execution works

A durable engine needs four parts:

1. **Named steps.** The job is a function that calls steps. Each step has a stable name, such as `checkout/01.charge-card.ts`.
2. **A step log.** When a step returns, the engine stores its name and result. The result must be plain data.
3. **Replay.** To continue, the engine runs the job function from the start. Steps in the log return their saved result. The first step not in the log runs for real.
4. **Retries.** When a step throws, the engine waits and runs only that step again, up to a limit.

Code outside a step runs again on each replay, so keep side effects (a payment, an email, a database write) inside steps. Cloudflare's [rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) give the same rules.

### Why steps must be idempotent

The log saves a result after the step returns. If the process stops between the payment API call and the save, the step runs again on replay. Fix it in the step: send the same idempotency key on every attempt, such as `charge:order_1042`, and the payment API returns the first result again. [Stripe's idempotent requests](https://docs.stripe.com/api/idempotent_requests) work this way.

Durable execution gives "at least once" per step. "Exactly once" for a side effect comes only from the step and the API it calls.

## Worked example: a checkout job that fails at step 2

Order `order_1042` costs $42.00. The job has three steps:

1. Charge the card.
2. Create a shipment at the shipping API.
3. Send the receipt email.

At 12:00:00 the job starts. Step 1 charges $42.00 and returns `{ chargeId: 'ch_1' }`. At 12:00:01 the shipping API returns `503`, and step 2 throws.

**Without durable execution**, the job fails. A retry runs the whole job, including step 1. Without an idempotency key, the customer pays $84.00.

**With durable execution**, the log has step 1's result, so the engine retries only step 2. With ViteHub's step defaults on OpenWorkflow, retries come at 12:00:11 and 12:00:31 (10 seconds, then 20). If the shipping API is back at 12:00:31, step 2 returns a tracking id, step 3 sends the receipt, and the card was charged once.

**If the process stops** during step 2, such as in a deploy at 12:00:05, the job starts again on another process. Step 1 returns `{ chargeId: 'ch_1' }` from the log without calling the payment API. Step 2 runs again.

**If every attempt fails**, the step and the run fail. The log still has step 1's result. Your code decides what to do next, such as a refund with the saved `chargeId`.

## What ViteHub stores on each host

For Cloudflare and OpenWorkflow, ViteHub calls each step file through the provider's step API with the default retry policy `limit: 3`, `delay: '10 seconds'`, `backoff: 'exponential'`. The two providers read the limit differently. Vercel native steps use Workflow DevKit's own policy.

| Where the run executes | Provider | Step results saved | Retries of a failed step | Survives a process stop |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | Cloudflare Workflows | Yes, by Cloudflare | Up to 3 retries after the first attempt, exponential backoff from 10 seconds | Yes |
| Node or Docker with `postgres.url` or `sqlite.path` | OpenWorkflow | Yes, in your Postgres or SQLite database | 3 attempts in total, 10 then 20 seconds apart | Yes, while the database survives |
| Vercel, explicit or generated `native` entry | Workflow DevKit | Yes, for `'use step'` functions | Workflow DevKit's rules | Yes |
| Vercel, normal handler | Inline | No | None | No |
| `vite dev` without a provider, and the Workflow that only `agent` turns on outside Cloudflare | Inline | No | None | No |

Cloudflare reads `limit` as the number of retries (see its [retry docs](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)). OpenWorkflow gets the same policy as `maximumAttempts: 3`, `initialInterval: '10 seconds'`, and `backoffCoefficient: 2`, so it makes 3 attempts in total.

An inline run executes the handler in the current process, kept alive after the response by the host's `waitUntil()` if it has one. Steps run in order, but nothing saves their results, and an error fails the run with no retry. A finished inline run's result stays in memory for five minutes, up to 1,024 runs, and a restart loses it. If the request has no Cloudflare Workflow binding, the Workflow also runs inline.

::warning
On Node or Docker, ViteHub picks OpenWorkflow when you set its storage. A build without `provider`, `postgres.url`, or `sqlite.path` fails with `WORKFLOW_C0020`. The default SQLite path, `.vitehub/data/openworkflow.sqlite.db`, is lost when a container or function file system is replaced. Read [Workflow hosts](/docs/workflows/hosts#select-openworkflow-storage) before production.
::

## Build the checkout Workflow in ViteHub

Enable Workflow with OpenWorkflow and SQLite on Node:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    workflow: {
      provider: 'openworkflow',
      sqlite: { path: '.data/workflows.sqlite' },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      workflow: {
        provider: 'openworkflow',
        sqlite: { path: '.data/workflows.sqlite' },
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      workflow: {
        provider: 'openworkflow',
        sqlite: { path: '.data/workflows.sqlite' },
      },
    }),
  ],
})
```
:::
::

On Cloudflare, set `host: 'cloudflare'` and `workflow: true`, with the same Workflow files.

In a Workflow folder, each numbered file is one durable step. `01.charge-card.ts` becomes `steps.chargeCard`, with the provider step name `checkout/01.charge-card.ts`. Do not rename a step file while runs are in progress, because the new name is not in their step log.

```ts [server/workflows/checkout/index.ts]
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow(
  'checkout',
  async (payload: { orderId: string, amountCents: number, email: string }, { steps }) => {
    // This code runs again on each replay. Keep side effects in the step files.
    const charged = await steps.chargeCard(payload)
    const shipped = await steps.createShipment(charged)
    return await steps.sendReceipt(shipped)
  },
)
```

Each step sends the same key on every attempt. Replace the `example.com` URLs with your services.

```ts [server/workflows/checkout/01.charge-card.ts]
export default async function chargeCard(order: { orderId: string, amountCents: number, email: string }) {
  const response = await fetch('https://payments.example.com/charges', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `charge:${order.orderId}`,
    },
    body: JSON.stringify({ amount: order.amountCents, currency: 'usd' }),
  })
  if (!response.ok) throw new Error(`Payment API returned ${response.status}`)
  const charge = await response.json() as { id: string }
  return { ...order, chargeId: charge.id }
}
```

```ts [server/workflows/checkout/02.create-shipment.ts]
export default async function createShipment(order: { orderId: string, chargeId: string, email: string }) {
  const response = await fetch('https://shipping.example.com/shipments', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': `ship:${order.orderId}`,
    },
    body: JSON.stringify({ reference: order.orderId }),
  })
  // A 503 throws here. The provider retries this step only.
  if (!response.ok) throw new Error(`Shipping API returned ${response.status}`)
  const shipment = await response.json() as { trackingId: string }
  return { ...order, trackingId: shipment.trackingId }
}
```

```ts [server/workflows/checkout/03.send-receipt.ts]
export default async function sendReceipt(order: { orderId: string, chargeId: string, trackingId: string, email: string }) {
  // Use an email API that accepts an idempotency key, or record that the receipt was sent.
  return { orderId: order.orderId, chargeId: order.chargeId, trackingId: order.trackingId, receiptSent: true }
}
```

Start the run with an id from the order:

```ts [server/api/checkout.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const order = await readBody<{ orderId: string, amountCents: number, email: string }>(event)
  if (!order) throw createError({ statusCode: 400, message: 'Order body is required' })
  return startWorkflow('checkout', order, { id: `checkout-${order.orderId}` })
})
```

Cloudflare uses the id as the instance id, and OpenWorkflow as its idempotency key, so a double click does not start a second checkout. Start with a letter, a digit, or `_`, then use only letters, digits, `-`, and `_` in the id, up to 100 characters, so it works on every provider. Cloudflare rejects other ids, and ViteHub fails the start with `WORKFLOW_CLOUDFLARE_RUN_ID_INVALID` before it calls Cloudflare. A Vercel `native` entry rejects an explicit id with `WORKFLOW_RUN_ID_UNSUPPORTED`; let Workflow DevKit assign it.

## Inspect the run

`startWorkflow()` returns the run `id` and a `status`. Read the run later with [`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run), or from the CLI while the dev server runs:

```bash [Terminal]
pnpm vitehub workflow start checkout '{"orderId":"order_1042","amountCents":4200,"email":"ada@example.com"}'
pnpm vitehub workflow get <runId>
pnpm vitehub inspect definitions --kind workflow
```

The status is `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`. On OpenWorkflow, `startWorkflow()` only stores the run. A long-lived worker process runs it, and it stays `queued` until a worker takes it (see the [Workflow package README](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker)). To see step 2 fail and retry, point `createShipment` at a URL that returns `503`.

## Durable steps on Vercel

A Workflow with a normal handler, such as the checkout's `index.ts` above, runs inline on Vercel unless you add a `native` entry. That entry uses Workflow DevKit's `'use workflow'` and `'use step'` directives. Vercel calls it without ViteHub's `steps` runner, so it must call its own step functions. See [Add a durable Vercel entry](/docs/workflows/configure#add-a-durable-vercel-entry).

For a folder with only numbered step files and no `index.ts`, ViteHub generates a native `'use workflow'` entry and one `'use step'` wrapper per file. The entry runs the files in order and passes each result to the next step, with no manual `native` entry. Both native forms follow Workflow DevKit's retry rules; see [Errors and retries](https://useworkflow.dev/docs/foundations/errors-and-retries).

## Related

- [Start your first Workflow](/docs/workflows/get-started): a two-step Workflow from a route.
- [Workflow concepts](/docs/workflows/concepts): runs, durable steps, and provider state.
- [Workflow hosts](/docs/workflows/hosts): providers and storage for each host.
- [Workflow server API](/docs/workflows/server-api): start, inspect, cancel, and resume runs.
- [Choose Queue, Workflow, or Schedule](/docs/guides/background-jobs): when a Queue is enough.
