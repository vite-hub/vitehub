---

title: Start your first Workflow
description: Define a two-step onboarding Workflow, start it from a route, and inspect the run id to follow its progress.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Workflow is a job made of steps that run in order, like a recipe. If one step fails, a durable provider can run only that step again and keep the results of the steps that already worked.

In this tutorial, you build a two-step user onboarding Workflow. Step one creates the user, and step two sends a welcome message. Both steps only return sample data for now. They do not use a database or send an email. Then you will start the Workflow from an API route.

> [!NOTE] Before you start
> Start with the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need no account. On the `node` host, the dev server runs Workflows with [OpenWorkflow](/docs/workflows/hosts#run-workflows-on-node) and stores each run in a SQLite file in `.vitehub/data`, so runs survive restarts.

::tutorial-step{title="Install"}
## Install

Install the Workflow package:

```bash pm [commands/install]
pnpm add @vite-hub/workflow
```

::

::tutorial-step{title="Define the Workflow steps"}
## Define the Workflow steps

Create the folder `server/workflows/onboard-user`. The folder name is the Workflow name: `onboard-user`. The `server/workflows` folder turns Workflows on, so you do not add a `workflow` option. Each numbered file in the folder is one step: `01.create-user.ts` and `02.send-welcome.ts`. Because each step is its own file, steps can be retried or replayed independently.

First, create `index.ts` to take the input and call the steps in order:

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow<{ email: string }>({
  handler: async ({ payload, steps }) => {
    const user = await steps.createUser(payload)
    return await steps.sendWelcome(user)
  },
})
```

- `{ email: string }` is the type of `payload`, the input that starts the run.
- `steps.createUser` calls `01.create-user.ts`, and `steps.sendWelcome` calls `02.send-welcome.ts`. ViteHub makes these names from the file names.
- To pause between steps, call `await sleep('1 day')` from the handler context. See [Retries and sleeps](/docs/workflows/limits-and-errors#retries-and-sleeps).

ViteHub writes types to `.vitehub/workflow.d.ts`, so `user` is typed and a step name without a file is a type error. If folders share a step name, the generated type requires inputs valid for every step with that name and returns the union of their results. At runtime, only the current folder's steps are available. `startWorkflow('onboard-user', payload)` checks the name and payload type.

Next, create the two step files:

```ts [server/workflows/onboard-user/01.create-user.ts]
export default async function createUser(input: { email: string }) {
  // Replace this with an idempotent database write.
  return { id: `user:${input.email}`, email: input.email }
}
```

```ts [server/workflows/onboard-user/02.send-welcome.ts]
export default async function sendWelcome(user: { id: string, email: string }) {
  // Replace this with an idempotent email or notification call.
  return { userId: user.id, email: user.email, welcomeSent: true }
}
```

A step can run more than once, so make it safe to repeat. For example, create or update the user by email. Do not add a new user on each try.

OpenWorkflow saves the result of each step. When a step fails, it retries only that step, up to 3 attempts in total.

[Durable execution](/docs/guides/durable-execution) shows a job that fails at step 2, and what each provider does then.

::

::tutorial-step{title="Start the Workflow from a route"}
## Start the Workflow from a route

Create `server/api/onboard.post.ts` to start `onboard-user` with the email from the request:

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  if (!payload) return new Response('Missing body', { status: 400 })
  const [error, run] = await startWorkflow('onboard-user', payload)
  if (error) throw error
  return run
})
```

::

::tutorial-step{title="Start and inspect a run"}
## Start and inspect a run

Start the dev server:

```bash [commands/start]
pnpm dev
```

From a second terminal, call the route:

```bash [commands/run]
curl -X POST http://localhost:3000/api/onboard \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

The response returns a unique run `id` and status:

```json [output/run.json]
{"id":"4d9bd450-b07f-42f6-9d0a-a7e3851d13c7","metadata":{"workflow":"onboard-user"},"provider":"openworkflow","result":null,"status":"queued","payload":{"email":"ada@example.com"}}
```

`"status":"queued"` means the run is stored. The OpenWorkflow worker in your dev server runs it a moment later. To see the status, result, or error of the run later, pass the run `id` to [`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run). Do not start a new run to check it.

The run returned by `getWorkflowRun()` does not include step history.

## Start a run from the CLI or the Console

You can also start a run from the CLI without a route. With the dev server running, run:

```bash [commands/cli-start]
pnpm vitehub workflow start onboard-user '{"email":"ada@example.com"}'
```

Then read the run back with its ID:

```bash [commands/cli-get]
pnpm vitehub workflow runs get <run-id> --json
```

```json [output/cli-get.json]
{
  "run": {
    "id": "2e7224ff-efaf-4046-89a0-a1b073567176",
    "metadata": {
      "namespaceId": "production",
      "version": null,
      "workflowName": "onboard-user"
    },
    "provider": "openworkflow",
    "result": {
      "userId": "user:ada@example.com",
      "email": "ada@example.com",
      "welcomeSent": true
    },
    "status": "completed",
    "workflow": "onboard-user"
  }
}
```

For a run started from a route, add `--workflow onboard-user` to `get`. Or open the Workflows page in the [Console](/docs/console) and click **Start**.

With `vitehub()`, `pnpm vitehub workflow runs list` lists runs that the dev server ran inline, such as on the `vercel` host. `pnpm vitehub workflow runs get <runId>` shows the steps, result, and error of an inline run. `pnpm vitehub workflow runs clear --yes` clears that history. Inline history does not include OpenWorkflow runs yet, so on `node` `runs list` prints `No runs.`. Use the same `runs get` command to read an OpenWorkflow run by ID.

:::details{summary="When the Start button and the commands are available"}
These commands call the Console RPC of the running app. They read a run with `workflow.get` and cancel it with `workflow.cancel` where the provider supports it. `workflow.start` and `workflow.resume` are registered only when `console.invoke` is enabled, and the Console hides Start and Resume when they are off. `workflow.cancel` stays available. See [Run Workflows in development](/docs/cli/primitives#run-workflows-in-development).
:::

::

## Next steps

::card-group
:::card{title="Durable execution" icon="i-lucide-refresh-cw" to="/docs/guides/durable-execution"}
See what happens when a step fails on each provider.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/workflows/hosts"}
Pick a durable Workflow provider for production.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/workflows/server-api"}
Start runs, check their status, and inspect the run shape.
:::
::
