---
title: Vercel
description: Configure @vitehub/workflow for Vercel builds while keeping the same workflow runtime API.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 1
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Vercel is the default provider when hosting is not Cloudflare. Set it explicitly when you want local builds to match Vercel deployment output.

::tabs{sync="framework"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite" class="p-4"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { hubWorkflow } from '@vitehub/workflow/vite'

    export default defineConfig({
      plugins: [hubWorkflow()],
      workflow: {
        provider: 'vercel',
      },
    })
    ```
  :::

  :::tabs-item{label="Nitro" icon="i-simple-icons-nuxtdotjs" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/workflow/nitro'],
      workflow: {
        provider: 'vercel',
      },
    })
    ```
  :::
::

## Generated output

Vite builds emit Vercel Build Output with a server function that installs the generated workflow registry before app code runs.

The application keeps the same calls:

```ts
await runWorkflow('welcome', payload)
await getWorkflowRun('welcome', run.id)
deferWorkflow('welcome', payload)
```

The generated workflow name uses the same stable encoding as Cloudflare:

```ts
workflow--77656c636f6d65
```

## Provider resolution

Provider resolution matches the other ViteHub packages:

1. `workflow.provider` wins when set.
2. Cloudflare hosting selects `cloudflare`.
3. All other hosting targets select `vercel`.

This means Vercel can be the local default:

```ts
workflow: {}
```

Use an explicit provider when test output should be deterministic:

```ts
workflow: {
  provider: 'vercel',
}
```

## Status behavior

Vercel runs return normalized metadata from the generated runtime:

```json
{
  "id": "wrun_lvn4hx4f_x8k2p9s1",
  "provider": "vercel",
  "status": "queued",
  "metadata": {
    "workflow": "workflow--77656c636f6d65"
  }
}
```

`getWorkflowRun()` can report `completed`, `failed`, or `unknown` for runs visible to the current deployment process.

::callout{icon="i-lucide-info" color="info"}
Keep user-facing persistence in your app database when a run id needs to be visible across cold starts, regions, or deployment versions.
::

## Deferred starts

`deferWorkflow()` uses the current request `waitUntil()` hook when Vercel exposes one through the runtime adapter:

```ts
export default defineEventHandler(() => {
  deferWorkflow('welcome', {
    email: 'ava@example.com',
  })

  return { ok: true }
})
```

The route returns immediately while the generated runtime starts the workflow asynchronously.
