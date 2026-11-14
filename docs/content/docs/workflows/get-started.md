---

title: Start your first Workflow
description: Define a two-step onboarding Workflow, start it from a route, and inspect the run id to follow its progress.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Workflow is a job made of steps that run in order, like a recipe. If one step fails, a durable provider can run that step again and keep the result of the steps that already worked.

In this tutorial, you build a Workflow with two steps that signs up a new user. The first step creates a user, and the second step sends a welcome message. Both steps only return sample data for now. They do not use a database or send an email. Then you start the Workflow from an API route.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run every command from the app root. You need no account: on your computer, the Workflow runs inside your server. A run started this way does not survive a server restart. Pick a [durable provider](/docs/workflows/hosts) before you rely on that.

::tutorial-step{title="Install and enable Workflows"}
## Install and enable Workflows

Add the Workflow package:

```bash pm [commands/install]
pnpm add @vite-hub/workflow
```

Add `workflow: true` to the ViteHub options of your app. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', workflow: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', workflow: true })],
})
```
::::
:::


::

::tutorial-step{title="Define the Workflow steps"}
## Define the Workflow steps

Create the folder `server/workflows/onboard-user`. The folder name is the name of the Workflow: `onboard-user`. Each file in it with a number in front is one step: `01.create-user` and `02.send-welcome`. Because each step is its own file, each step can be retried or replayed independently.

First, create `index.ts`. It gets the input and calls the steps in order:

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('onboard-user', async (payload: { email: string }, { steps }) => {
  const user = await steps.createUser(payload)
  return await steps.sendWelcome(user)
})
```

- The first argument is the Workflow name, the same as the folder name.
- `payload` is the input that starts the run. Here, it is an email.
- `steps.createUser` runs the file `01.create-user.ts`, and `steps.sendWelcome` runs `02.send-welcome.ts`. ViteHub makes these names from the file names.

ViteHub writes the step types to `.vitehub/workflow.d.ts`. Each step takes the input type of its file and returns its result, so `user` is typed and a misspelled step is a type error. The step runner works with each Workflow provider.

Then create the two steps:

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

The local inline provider used here runs each step once. It does not replay failed steps. Use a durable provider when you need that behavior.

[Durable execution](/docs/guides/durable-execution) shows a job that fails at step 2, and what each provider does then.

::

::tutorial-step{title="Start the Workflow from a route"}
## Start the Workflow from a route

Create `server/api/onboard.post.ts`. This route starts the `onboard-user` Workflow with the email from the request.

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  return startWorkflow('onboard-user', payload)
})
```

::

::tutorial-step{title="Start and inspect a run"}
## Start and inspect a run

Start the dev server:

```bash [commands/start]
pnpm dev
```

Open a second terminal, and call the route:

```bash [commands/run]
curl -X POST http://localhost:3000/api/onboard \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

The response has a run id and a status. Your run id is different:

```json [output/run.json]
{"id":"wrun_mw6hmkr0_kvp6dm99","metadata":{"mode":"inline","workflow":"workflow--6f6e626f6172642d75736572"},"payload":{"email":"ada@example.com"},"provider":"vercel","status":"queued"}
```

`"mode":"inline"` means that the run executes inside your dev server. The run id identifies this run. To see the status, result, or error of the run later, pass the run id to [`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run). Do not start a new run to check it.

Local inline execution keeps the final result of the run. The run returned by `getWorkflowRun()` does not include step history.

## Start a run from the CLI or the Console

You can also start a run without a route. Keep the dev server running, and run:

```bash [commands/cli-start]
pnpm vitehub workflow start onboard-user '{"email":"ada@example.com"}'
```

Then read the run back with its id:

```bash [commands/cli-get]
pnpm vitehub workflow get <run-id>
```

```json [output/cli-get.json]
{
  "run": {
    "id": "wrun_mw6hmtp4_5y5qt0lg",
    "provider": "vercel",
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

For a run that you started from the route, add `--workflow onboard-user` to `get`. Or open the Workflows page of the [Console](/docs/console) and click **Start**.

With `vitehub()`, `pnpm vitehub workflow runs list` lists the runs that the dev server recorded. `pnpm vitehub workflow runs show <runId>` shows the steps, result, and error of one run. `pnpm vitehub workflow runs clear --yes` clears that history.

:::details{summary="When the Start button and the commands are available"}
The commands call the Console RPC of the running app. They read a run back with `workflow.get` and cancel it with `workflow.cancel` where the provider supports it. `workflow.start` and `workflow.resume` are registered only when `console.invoke` is on, and the Console hides Start and Resume when they are not (`workflow.cancel` stays available). See [Run Workflows in development](/docs/cli/jobs#run-workflows-in-development).
:::

::

## Next steps

::card-group
:::card{title="Durable execution" icon="i-lucide-refresh-cw" to="/docs/guides/durable-execution"}
See what happens when a step fails, on each provider.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/workflows/hosts"}
Pick a durable provider for production.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/workflows/server-api"}
Start runs, read their status, and see the run shape.
:::
::
