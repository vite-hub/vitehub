---
title: Sandbox quickstart
description: Register Sandbox, define one sandbox, and run it from a route.
navigation.title: Quickstart
frameworks: [vite, nitro]
---

This quickstart wires a `release-notes` sandbox and a route that executes it. Pick Cloudflare or Vercel in app config; the definition and route code stay the same.

::steps

### Install the package

```bash
pnpm add @vitehub/sandbox
```

Install the provider SDK you use at runtime:

```bash
pnpm add @cloudflare/sandbox
```

```bash
pnpm add @vercel/sandbox
```

### Register Sandbox

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the provider you deploy to:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { hubSandbox } from '@vitehub/sandbox/vite'

    export default defineConfig({
      plugins: [hubSandbox()],
      sandbox: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { hubSandbox } from '@vitehub/sandbox/vite'

    export default defineConfig({
      plugins: [hubSandbox()],
      sandbox: {
        provider: 'vercel',
      },
    })
    ```
  :::
::
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and choose the provider you deploy to:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/sandbox/nitro'],
      sandbox: {
        provider: 'cloudflare',
      },
    })
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts [nitro.config.ts]
    import { defineNitroConfig } from 'nitro/config'

    export default defineNitroConfig({
      modules: ['@vitehub/sandbox/nitro'],
      sandbox: {
        provider: 'vercel',
      },
    })
    ```
  :::
::
::

### Define a sandbox

::fw{id="vite:dev vite:build"}
Create a discovered sandbox file in `src/**/*.sandbox.ts`:

```ts [src/release-notes.sandbox.ts]
import { defineSandbox } from '@vitehub/sandbox'

export type ReleaseNotesPayload = {
  notes?: string
}

export default defineSandbox(async (payload: ReleaseNotesPayload = {}) => {
  const items = (payload.notes || '')
    .split('\n')
    .map(note => note.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return {
    summary: items[0] || '',
    items,
  }
})
```
::

::fw{id="nitro:dev nitro:build"}
Create a discovered sandbox file in `server/sandboxes/**`:

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vitehub/sandbox'

export type ReleaseNotesPayload = {
  notes?: string
}

export default defineSandbox(async (payload: ReleaseNotesPayload = {}) => {
  const items = (payload.notes || '')
    .split('\n')
    .map(note => note.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return {
    summary: items[0] || '',
    items,
  }
})
```
::

### Run the sandbox

::fw{id="vite:dev vite:build"}
Add a small Vite server entry that calls Sandbox:

```ts [src/server.ts]
import { createError, H3 } from 'h3'
import { readRequestPayload, runSandbox } from '@vitehub/sandbox'

const app = new H3()

app.post('/api/release-notes', async (event) => {
  const payload = await readRequestPayload(event, { notes: '' })
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return { result: result.value }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
Add one route that runs the discovered sandbox:

```ts [server/api/release-notes.post.ts]
import { readRequestPayload, runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const payload = await readRequestPayload(event, { notes: '' })
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return { result: result.value }
})
```
::

### Verify that it worked

Deploy or run the app with a configured provider, then send one request:

```bash
curl -X POST http://localhost:3000/api/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added weekly digest\n- Tightened signup copy"}'
```

You should see a JSON response with the computed sandbox result:

```json
{
  "result": {
    "summary": "Added weekly digest",
    "items": [
      "Added weekly digest",
      "Tightened signup copy"
    ]
  }
}
```

::

## What to read next

- Use [Runtime API](./runtime-api) for the exact exports and types.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for provider-specific setup.
