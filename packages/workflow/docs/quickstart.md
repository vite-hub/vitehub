---
title: Workflow quickstart
description: Register Workflow, define a welcome flow, start a run from a route, and verify the normalized response.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one `welcome` workflow. The route accepts a payload, starts a workflow run, and returns the normalized run metadata.

The provider is the only part that changes between Cloudflare and Vercel. The workflow definition and start call stay the same.

::code-collapse

```txt [Prompt]
Set up @vitehub/workflow in this app.

- Install @vitehub/workflow
- Register hubWorkflow() for Vite or @vitehub/workflow/nitro for Nitro
- Configure workflow.provider as cloudflare or vercel
- Define welcome as a discovered workflow
- Call runWorkflow('welcome', payload) from a route
- Return the workflow run to the caller

Docs: /docs/vite/workflow/quickstart or /docs/nitro/workflow/quickstart
```

::

::steps

### Install Workflow

```bash
pnpm add @vitehub/workflow
```

Cloudflare uses runtime Workflow bindings. Vercel uses generated ViteHub runtime output for the same public API.

### Register the integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the provider:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { hubWorkflow } from '@vitehub/workflow/vite'

    export default defineConfig({
      plugins: [hubWorkflow()],
      workflow: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
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
::
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the provider:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/workflow/nitro'],
      workflow: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
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
::

### Define the workflow

::fw{id="vite:dev vite:build"}
Create a discovered Vite workflow file:

```ts [src/welcome.workflow.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    provider,
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered Nitro workflow file:

```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    provider,
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```
::

### Start from a route

::fw{id="vite:dev vite:build"}
Add a Vite server entry that reads the request body and starts the named workflow:

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from './welcome.workflow'

const app = new H3()

app.post('/api/welcome', async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, payload, run }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
Add a Nitro route that reads the request body and starts the named workflow:

```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from '../workflows/welcome'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, payload, run }
})
```
::

### Verify the response

Run or deploy the app with a configured provider, then send a request:

```bash
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","marker":"docs"}'
```

The route returns the workflow run metadata:

```json
{
  "ok": true,
  "payload": {
    "email": "ava@example.com",
    "marker": "docs"
  },
  "run": {
    "id": "wrun_lvn4hx4f_x8k2p9s1",
    "provider": "vercel",
    "status": "queued"
  }
}
```

::
