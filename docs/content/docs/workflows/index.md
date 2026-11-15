---
title: Workflows
layout: landing
navigation.title: Overview
description: Run long tasks in steps, get a run id at once, and check the status and result later.
navigation.order: 1
icon: i-lucide-workflow
---

::product-hero{tagline="Run long tasks in steps, then check their status and result later with a run id." hosts="Cloudflare, Vercel, Node, Docker"}
  :hero-figure{name="workflows"}
::

::code-tree
```ts [server/workflows/onboard-user/index.ts]
import { defineWorkflow } from 'vite-hub/workflow'

// Each numbered file in this folder is a step.
// They run in the order you call them.
export default defineWorkflow(
  'onboard-user',
  async (payload: { email: string }, { steps }) => {
    const user = await steps.createUser(payload)
    return await steps.sendWelcome(user)
  },
)
```

```ts [server/workflows/onboard-user/01.create-user.ts]
// Step 1: create the user
export default async function createUser(input: {
  email: string
}) {
  // Save the user in your database here
  const id = `user:${input.email}`
  return { id, email: input.email }
}
```

```ts [server/workflows/onboard-user/02.send-welcome.ts]
// Step 2: send the welcome message
export default async function sendWelcome(user: {
  id: string
  email: string
}) {
  return { userId: user.id, welcomeSent: true }
}
```

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

// Start a run and return its id at once
export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  return startWorkflow('onboard-user', body)
})
```

```ts [server/api/runs/[id].get.ts]
import { defineEventHandler, getRouterParam } from 'h3'
import { getWorkflowRun } from 'vite-hub/workflow'

// Read the status and result of one run
export default defineEventHandler((event) => {
  const id = getRouterParam(event, 'id')!
  return getWorkflowRun('onboard-user', id)
})
```
::

::product-features
  :::product-feature-item{title="One file or folder per workflow" icon="i-lucide-file-code-2" to="/docs/workflows/configure#define-a-workflow"}
  Add a file to `server/workflows`. Its name is the workflow name.
  :::

  :::product-feature-item{title="Split work into steps" icon="i-lucide-list-checks" to="/docs/workflows/get-started#define-the-workflow-steps"}
  Put numbered files in a workflow folder. A durable host can retry a failed step.
  :::

  :::product-feature-item{title="Start now, check later" icon="i-lucide-play-circle" to="/docs/workflows/server-api#start-a-run"}
  `startWorkflow()` starts a run and returns its id. Your route does not wait for the work.
  :::

  :::product-feature-item{title="Status and result" icon="i-lucide-activity" to="/docs/workflows/server-api#inspect-a-run"}
  `getWorkflowRun()` returns the status (queued, running, completed, or failed) and the result.
  :::

  :::product-feature-item{title="Choose where runs live" icon="i-lucide-cloud-cog" to="/docs/workflows/hosts#providers"}
  Use Cloudflare, Vercel, or OpenWorkflow with Postgres or SQLite on your own server. Routes stay the same.
  :::

  :::product-feature-item{title="Clear error codes" icon="i-lucide-circle-alert" to="/docs/workflows/limits-and-errors#structured-errors"}
  Throw an error with a fixed code that is the same on every host.
  :::
::

::agent-only{skill="workflow"}
Use Workflows for provider-tracked work that can outlive a request and needs durable state, retries, or steps. A run id is the handle for inspection.

Make each step idempotent and define terminal failure behavior. Keep request handlers small: start the run, return its id, and inspect the run separately.

Prove start, retry or resume, cancellation, and a terminal result. Inspect provider state instead of assuming the request process owns the run.
::
