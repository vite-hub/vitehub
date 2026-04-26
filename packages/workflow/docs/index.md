---
title: Workflow
description: Run durable, provider-backed workflows from Vite and Nitro with one portable API.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

`@vitehub/workflow` gives Vite and Nitro apps one way to define long-running work, start a named workflow from request code, and observe the run through Cloudflare Workflows or Vercel.

Use Workflow when background work has multiple steps, needs a stable run id, or should be visible after the request that started it has already returned.

::code-group
```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from '../workflows/welcome'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, run }
})
```

```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ payload }) => {
  return {
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```

```json [Response]
{
  "ok": true,
  "run": {
    "id": "wrun_lvn4hx4f_x8k2p9s1",
    "provider": "cloudflare",
    "status": "queued"
  }
}
```
::

## What Workflow solves

Queues are a good fit for one handler. Workflows are better when the operation has an identity and the caller may need to ask what happened later.

Workflow keeps that boundary explicit:

::card-group
  :::card
  ---
  icon: i-lucide-git-branch
  title: Named flows
  ---
  Put multi-step work behind a discovered `defineWorkflow()` definition instead of scattering logic across request handlers.
  :::

  :::card
  ---
  icon: i-lucide-play
  title: Portable starts
  ---
  Call `runWorkflow()` or `deferWorkflow()` the same way on Cloudflare and Vercel.
  :::

  :::card
  ---
  icon: i-lucide-search-check
  title: Run observation
  ---
  Use a normalized run id, provider, status, result, and metadata shape in app code.
  :::

  :::card
  ---
  icon: i-lucide-file-code-2
  title: Generated registry
  ---
  Let ViteHub discover workflow files and generate the runtime registry for the active framework.
  :::
::

## One portable flow

The same application shape works across providers:

1. Register the Vite plugin or Nitro module.
2. Choose `cloudflare` or `vercel` in `workflow.provider`.
3. Define a named workflow with `defineWorkflow()`.
4. Start it with `runWorkflow(name, payload)`.
5. Check it later with `getWorkflowRun(name, id)` when the provider can report status.

::callout{icon="i-lucide-info" color="info"}
Provider setup belongs in app config and generated deployment output. Workflow definitions and start calls should stay provider-neutral whenever possible.
::

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers workflow definitions from `*.workflow.ts` files and `server/workflows/**`.

The workflow name comes from the path without the `.workflow` suffix. `src/email/welcome.workflow.ts` becomes `email/welcome`. `server/workflows/welcome.ts` becomes `welcome`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers workflow definitions from `server/workflows/**`.

The workflow name comes from the path under `server/workflows`, without the file extension. `server/workflows/email/welcome.ts` becomes `email/welcome`.
::

## Supported providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Cloudflare Workflows with generated Wrangler bindings and workflow entrypoint classes.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel deployment output while keeping the ViteHub workflow runtime API in app code.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start here

Start with [Quickstart](./quickstart) for the smallest complete setup. Use the [primitive comparison](../compare) when you are deciding between KV, Blob, Queue, Sandbox, Workflow, or inline request code.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Define a welcome workflow and start it from a route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use typed payloads, deferred starts, stable run ids, and status checks.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, signatures, options, status values, and helper functions.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix unknown workflows, missing bindings, disabled config, and provider mismatches.
  to: ./troubleshooting
  ---
  :::
::
