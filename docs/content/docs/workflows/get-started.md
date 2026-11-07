---
title: Start your first Workflow
description: Define a two-step onboarding Workflow, start it from a route, and inspect the run id to follow its progress.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You build a Workflow with two steps and start it from an API route. A Workflow is a job made of steps that run in order. Here, one step creates a sample user and the next step returns a sample welcome result. The steps do not use a database or send an email yet. At the end, you get a run id for the job.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run every command from its root folder.

You do not need a cloud account. On your computer, the steps run directly in the server process.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/runtime @vite-hub/workflow nitro h3
pnpm add -D vite
```

`@vite-hub/workflow` runs the Workflow, and `@vite-hub/runtime` is the ViteHub server code that it uses. `nitro` and `h3` serve the API route. `vite` runs the dev server.

Add the plugins to `vite.config.ts`. Keep the other plugins that your config already has. `hubWorkflow()` finds the Workflows in `server/workflows/`.

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkflow(), nitro()],
})
```

::

::tutorial-step{title="Write the steps"}
## Write the steps

Put a Workflow with more than one step in a folder. The folder name is the Workflow name, here `onboard-user`.

Create `server/workflows/onboard-user/index.ts`. It gets the input, called the payload, and calls the steps in order:

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload, steps }) => {
  const user = await steps.createUser(payload)
  return await steps.sendWelcome(user)
})
```

Each other file in the folder is one step. The number at the start sets the order, and the rest is the step name: `01.create-user` and `02.send-welcome`. ViteHub gives each step a function in `steps`. `01.create-user.ts` becomes `steps.createUser`, and `02.send-welcome.ts` becomes `steps.sendWelcome`. Because each step is separate, each step can be retried or replayed independently.

Create the two step files:

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

When you add real work, make each step safe to run two times. This is called idempotent. For example, create or update a user by email. Do not insert a new user on each retry. A durable provider, one that saves each step's result, can run a failed step again and keep the steps that finished before it. [Durable execution](/docs/guides/durable-execution) shows a job that fails at step 2 on each provider.

> [!NOTE]
> The local provider in this tutorial does not save step results. If the server restarts during a run, the run is lost. Choose a [durable provider](/docs/workflows/hosts) before you depend on that.

::

::tutorial-step{title="Start the Workflow from a route"}
## Start the Workflow from a route

Create `server/api/onboard.post.ts`. It reads the email from the request body and starts the `onboard-user` Workflow with it:

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  return runWorkflow('onboard-user', payload)
})
```

`runWorkflow()` returns the run. A run is one execution of the Workflow, and its id identifies it.

::

::tutorial-step{title="Start a run"}
## Start a run

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. Open a second terminal and send an email to the route:

```bash [commands/run]
curl -X POST http://localhost:5173/api/onboard \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

The response includes the run `id` and its `status`. This proves that the route started the Workflow.

To read the run again later, pass the Workflow name and the run id to [`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run). It returns the final status, and the result or the error. Do not start a new run to check the first one. The local provider keeps the final result, but not the result of each step.

::

## Next steps

- [Run Workflows in development](/docs/development/cli#run-workflows-in-development): start, read, and cancel runs with `vitehub workflow start onboard-user --payload '{"email":"ada@example.com"}'` or from the [Console](/docs/development/console). These need the `vitehub()` plugin, not only `hubWorkflow()`.
- [Hosts](/docs/workflows/hosts): choose a durable provider that keeps each step after a restart.
- [Durable execution](/docs/guides/durable-execution): see how retries work when a step fails.
- [Server API](/docs/workflows/server-api): read the full shape of a run.
