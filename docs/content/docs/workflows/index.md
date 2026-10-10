---
title: Workflows
navigation.title: Overview
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 1
icon: i-lucide-workflow
---

::product-hero{tagline="Start long-running work as a tracked run with an id, status, and result on Cloudflare, Vercel, or OpenWorkflow." hosts="Cloudflare, Vercel, Node, Docker"}
  :::code-group
  ```ts [Route]
  import { runWorkflow } from '@vite-hub/workflow'

  export default defineEventHandler(async (event) => {
    const body = await readBody<{ email: string }>(event)

    // A stable id deduplicates the same logical run on providers that accept one.
    const run = await runWorkflow('onboard-user', body, { id: `onboard:${body.email}` })

    // Read it later with getWorkflowRun('onboard-user', run.id).
    return run
  })
  ```

  ```ts [Definition]
  import { defineWorkflow } from '@vite-hub/workflow'

  export default defineWorkflow<{ email: string }>(async ({ payload }) => {
    const user = await createUser(payload.email)
    await sendWelcomeEmail(user.email)

    return { userId: user.id }
  })
  ```

  ```ts [Status]
  import { getWorkflowRun } from '@vite-hub/workflow'

  export default defineEventHandler((event) => {
    return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
  })
  ```

  ```ts [vite.config.ts]
  import { hubWorkflow } from '@vite-hub/workflow/vite'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [hubWorkflow()],
    workflow: { provider: 'cloudflare' },
  })
  ```
  :::
::


::product-features
  :::product-feature-item{title="One file, one named Workflow" icon="i-lucide-code-2" to="/docs/workflows/configure"}
  `server/workflows/<name>.ts` gets the payload, run id, and step helpers.
  :::

  :::product-feature-item{title="Start by name, read by id" icon="i-lucide-play-circle" to="/docs/workflows/server-api"}
  `getWorkflowRun()` returns the status and, when available, the result.
  :::

  :::product-feature-item{title="Durable steps on Vercel with a native entry" icon="i-lucide-workflow" to="/docs/workflows/configure#add-a-durable-vercel-entry"}
  A `native` entry runs on Workflow DevKit for durable steps.
  :::

  :::product-feature-item{title="One error contract on every provider" icon="i-lucide-circle-alert" to="/docs/workflows/limits-and-errors"}
  Throw `ViteHubError` with a stable `code`; `toJSON()` omits `cause`.
  :::

  :::product-feature-item{title="Pick the provider and its storage per host" icon="i-lucide-cloud-cog" to="/docs/workflows/hosts"}
  Cloudflare or Vercel by host; OpenWorkflow with `postgres.url` or `sqlite.path`.
  :::

  :::product-feature-item{title="Steps survive retries" icon="i-lucide-refresh-cw" to="/docs/workflows/server-api"}
  Durable steps resume after a worker or provider failure.
  :::
::
