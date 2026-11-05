---
title: What is durable execution? Steps, retries, replay, and idempotency
description: Durable execution saves the result of each step, so a failed job continues from the failed step. See a worked example and what ViteHub Workflows store on each host.
navigation.title: Durable execution
navigation.order: 41
navigation.group: Concepts
icon: i-lucide-history
---

Durable execution means that a job saves the result of each step in storage outside the process. When a step fails, the engine retries only that step. When the process stops, the engine starts the job again and replays it: completed steps return their saved result and do not run again. The job continues from the step that did not finish. A step can still run more than one time, so each step must be idempotent. In ViteHub, a Workflow is durable only when its provider stores the steps: Cloudflare Workflows, OpenWorkflow with Postgres or SQLite, or a Vercel `native` entry. The inline runs of `vite dev` and of a normal Vercel handler are not durable.

## How durable execution works

A durable engine needs four parts:

1. **Named steps.** The job is a function that calls steps. Each step has a stable name, such as `checkout/01.charge-card.ts`.
2. **A step log.** When a step returns, the engine writes its name and its result to storage. The result must be plain data, because the engine stores it.
3. **Replay.** To continue a job, the engine runs the job function again from the start. For each step that is in the log, it returns the saved result instead of running the step. The first step that is not in the log runs for real.
4. **Retries.** When a step throws, the engine waits and runs that step again, up to a limit. The other steps do not run again.

Code outside a step runs again on each replay. Keep side effects, such as a payment, an email, or a database write, inside steps. Read Cloudflare's [rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) for the same rules from the provider side.

### Why steps must be idempotent

The log saves a step result after the step returns. If the process stops after the step called the payment API, but before the engine saved the result, the step runs again on replay. The engine cannot know that the first call succeeded. The fix is in the step: send an idempotency key that is the same on every attempt, such as `charge:order_1042`. Then the payment API returns the first result for the second call. [Stripe's idempotent requests](https://docs.stripe.com/api/idempotent_requests) work this way.

Durable execution gives you "at least once" for each step. "Exactly once" for a side effect comes only from the step and the API that it calls.

## Worked example: a checkout job that fails at step 2

Order `order_1042` costs $42.00. The job has three steps:

1. Charge the card.
2. Create a shipment at the shipping API.
3. Send the receipt email.

At 12:00:00, the job starts. Step 1 charges $42.00 and returns `{ chargeId: 'ch_1' }`. At 12:00:01, the shipping API returns `503`, and step 2 throws.

**Without durable execution**, the job fails. A retry starts the whole job again, so step 1 runs again. Without an idempotency key, the customer pays $84.00.

**With durable execution**, the log already has the result of step 1. The engine retries only step 2. With ViteHub's step defaults on OpenWorkflow, the retries come at 12:00:11 and at 12:00:31 (10 seconds, then 20 seconds). If the shipping API is back at 12:00:31, step 2 returns a tracking id, step 3 sends the receipt, and the card was charged one time.

**If the process stops** during step 2, for example in a deploy at 12:00:05, the engine starts the job again on another process. Step 1 is in the log, so it returns `{ chargeId: 'ch_1' }` without a call to the payment API. Step 2 runs again.

**If every attempt fails**, the step fails and the run fails. The log still has the result of step 1. Your code decides what to do next, for example a refund with the saved `chargeId`.

## What ViteHub stores on each host

For Cloudflare and OpenWorkflow, ViteHub calls each step file through the provider's step API with the default retry policy: `limit: 3`, `delay: '10 seconds'`, and `backoff: 'exponential'`. These two providers read the limit in different ways. Vercel native steps use Workflow DevKit's own retry policy.

| Where the run executes | Provider | Step results saved | Retries of a failed step | Survives a process stop |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | Cloudflare Workflows | Yes, by Cloudflare | Up to 3 retries after the first attempt, with exponential backoff from 10 seconds | Yes |
| Node or Docker with `postgres.url` or `sqlite.path` | OpenWorkflow | Yes, in your Postgres or SQLite database | Up to 3 attempts in total, 10 seconds then 20 seconds apart | Yes, while the database survives |
| Vercel, explicit or generated `native` entry | Workflow DevKit | Yes, for `'use step'` functions | Workflow DevKit's own rules | Yes |
| Vercel, normal handler | Inline | No | None | No |
| Node or Docker without OpenWorkflow storage, and `vite dev` | Inline | No | None | No |

Cloudflare reads `limit` as the number of retries, as its [retry documentation](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) explains. ViteHub gives OpenWorkflow the same policy as `maximumAttempts: 3`, `initialInterval: '10 seconds'`, and `backoffCoefficient: 2`, so OpenWorkflow makes 3 attempts in total.

An inline run executes the handler in the current process. After the response, ViteHub keeps it alive with the host's `waitUntil()` when the host has one. The steps run in order, but nothing saves their results, and a thrown error fails the run with no retry. ViteHub keeps the result of a completed inline run in memory for five minutes, up to 1,024 runs. A restart loses it. When ViteHub finds no Cloudflare Workflow binding on the request, it also runs the Workflow inline.

On Node or Docker, ViteHub selects OpenWorkflow only when you configure its storage. Without `postgres.url` or `sqlite.path`, the provider is Vercel, and off Vercel that means inline runs. The SQLite default path, `.vitehub/data/openworkflow.sqlite.db`, is lost when a container or function file system is replaced. Read [Workflow hosts](/docs/workflows/hosts#select-openworkflow-storage) before production.

## Build the checkout Workflow in ViteHub

Enable Workflow with OpenWorkflow and SQLite on Node:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      workflow: {
        provider: 'openworkflow',
        sqlite: { path: '.data/workflows.sqlite' },
      },
    }),
  ],
})
```

On Cloudflare, set `preset: 'cloudflare'` and `workflow: true`. The Workflow files stay the same.

A Workflow folder with numbered files gives one durable step for each file. `01.charge-card.ts` becomes `steps.chargeCard`, and its step name on the provider is `checkout/01.charge-card.ts`. Do not rename a step file while runs are in progress, because the new name is not in their step log.

```ts [server/workflows/checkout/index.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ orderId: string, amountCents: number, email: string }>(
  async ({ payload, steps }) => {
    // This code runs again on each replay. Keep side effects in the step files.
    const charged = await steps.chargeCard(payload)
    const shipped = await steps.createShipment(charged)
    return await steps.sendReceipt(shipped)
  },
)
```

Each step sends a key that is the same on every attempt. Replace the `example.com` URLs with your own services.

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

Start the run with an id that comes from the order:

```ts [server/api/checkout.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const order = await readBody<{ orderId: string, amountCents: number, email: string }>(event)
  return runWorkflow('checkout', order, { id: `checkout:${order.orderId}` })
})
```

ViteHub gives the id to the provider. Cloudflare uses it as the instance id, and OpenWorkflow uses it as its idempotency key, so a double click does not start a second checkout. A Vercel `native` entry rejects an explicit id with `WORKFLOW_RUN_ID_UNSUPPORTED`; let Workflow DevKit assign it.

## Inspect the run

The response of `runWorkflow()` has the run `id` and a `status`. Read the run later with [`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run), or from the CLI while the dev server runs:

```bash [Terminal]
pnpm vitehub workflow start checkout --payload '{"orderId":"order_1042","amountCents":4200,"email":"ada@example.com"}'
pnpm vitehub workflow get <runId>
pnpm vitehub inspect definitions --kind workflow
```

The status is one of `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`. On OpenWorkflow, `runWorkflow()` only puts the run in storage. A long-lived worker process executes it, and the run stays `queued` until a worker takes it. The [Workflow package README](https://github.com/vite-hub/vitehub/tree/main/packages/workflow#run-an-openworkflow-worker) shows the worker. To see step 2 fail and retry, point `createShipment` at a URL that returns `503`.

## Durable steps on Vercel

For Workflows with a normal handler, including the checkout's `index.ts` above, Vercel runs the handler inline unless you provide a `native` entry. That entry uses Workflow DevKit's `'use workflow'` and `'use step'` directives. Vercel calls it without ViteHub's `steps` runner, so the entry must call its own step functions. [Add a durable Vercel entry](/docs/workflows/configure#add-a-durable-vercel-entry) shows the code.

For a folder containing only numbered step files and no `index.ts`, ViteHub generates a native `'use workflow'` entry and one `'use step'` wrapper per file. The generated entry runs the files in order, passing each result to the next step. This form needs no manual `native` entry. Both native forms follow Workflow DevKit's own retry rules; read [Errors and retries](https://useworkflow.dev/docs/foundations/errors-and-retries).

## Related

- [Start your first Workflow](/docs/workflows/get-started): a two-step Workflow from a route.
- [Workflow concepts](/docs/workflows/concepts): runs, durable steps, and provider state.
- [Workflow hosts](/docs/workflows/hosts): providers and storage for each host.
- [Workflow server API](/docs/workflows/server-api): start, inspect, cancel, and resume runs.
- [Choose Queue, Workflow, or Schedule](/docs/guides/background-jobs): when a Queue is enough.
