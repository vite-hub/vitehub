---

title: Start your first Workflow
description: Start a two-step onboarding Workflow and inspect its run id.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Build a two-step onboarding Workflow and start it from an API route. One step creates a sample user; the next returns a sample welcome result. Neither step calls a database or sends an email yet. You will get a run id that identifies this execution.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. Local execution runs inline and needs no provider account. Select a [durable provider](/docs/workflows/hosts) before relying on a run surviving a server restart.

::tutorial-step{title="Install and configure"}
## Install and configure

Install Workflow and Nitro. Add the plugins below to your existing Vite config and keep its other plugins.

```bash [commands/install]
pnpm add @vite-hub/runtime @vite-hub/workflow nitro h3
pnpm add -D vite
```

```ts [vite.config.ts]
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubWorkflow(), nitro() as never],
})
```

::

::tutorial-step{title="Define the Workflow steps"}
## Define the Workflow steps

Use a folder when a Workflow has more than one durable operation. The
`index.ts` file receives the payload and calls the generated step functions in
order. Files with a numeric prefix become step names (`01.create-user` and
`02.send-welcome`) and each step can be retried or replayed independently.

```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload, steps }) => {
  const user = await steps!.createUser(payload)
  return await steps!.sendWelcome(user)
})
```

The step runner is provider-neutral. ViteHub maps `createUser` to
`01.create-user.ts` and `sendWelcome` to `02.send-welcome.ts`.

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

Make each side effect safe to repeat. For example, create or update a user by email instead of inserting another user on every retry. A durable provider can replay a failed step while keeping earlier completed steps. The local inline provider used here does not retain that step history.

::

::tutorial-step{title="Start the Workflow from a route"}
## Start the Workflow from a route

The route submits the email as a payload. Use the returned run id to inspect this execution rather than starting another run to check it.

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  return runWorkflow('onboard-user', payload)
})
```

::

::tutorial-step{title="Start and inspect a run"}
## Start and inspect a run

Start Vite and call the route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/run]
curl -X POST http://localhost:5173/api/onboard \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com"}'
```

The response includes a run id and a provider status. Use
[`getWorkflowRun()`](/docs/workflows/server-api#inspect-a-run) with that id to
inspect the final run status, result, or error metadata after the handler
completes. Local inline execution retains the final result. It does not retain
step history.

::
