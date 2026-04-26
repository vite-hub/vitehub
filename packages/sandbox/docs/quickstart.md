---
title: Sandbox quickstart
description: Register Sandbox, define a release-notes sandbox, call it from a route, and verify the JSON result.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide creates one `release-notes` sandbox. The route accepts markdown-style notes, runs the sandbox in an isolated provider runtime, and returns a normalized JSON result.

The provider is the only part that changes between Cloudflare and Vercel. The sandbox definition and route call stay the same.

::code-collapse

```txt [Prompt]
Set up @vitehub/sandbox in this app.

- Install @vitehub/sandbox and one provider SDK
- Register hubSandbox() for Vite or @vitehub/sandbox/nitro for Nitro
- Configure sandbox.provider as cloudflare or vercel
- Define release-notes as a discovered sandbox
- Call runSandbox('release-notes', payload) from a route
- Handle result.isErr() before reading result.value

Docs: /docs/vite/sandbox/quickstart or /docs/nitro/sandbox/quickstart
```

::

::steps

### Install Sandbox

```bash
pnpm add @vitehub/sandbox
```

Install the provider SDK for the platform that will execute the sandbox:

::code-group
```bash [Cloudflare]
pnpm add @cloudflare/sandbox
```

```bash [Vercel]
pnpm add @vercel/sandbox
```
::

### Register the integration

::fw{id="vite:dev vite:build"}
Register the Vite plugin and choose the provider:

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
Register the Nitro module and choose the provider:

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

### Define the sandbox

::fw{id="vite:dev vite:build"}
Create a discovered Vite sandbox file:

```ts [src/release-notes.sandbox.ts]
import { defineSandbox } from '@vitehub/sandbox'

export type ReleaseNotesPayload = {
  notes?: string
}

export type ReleaseNotesResult = {
  summary: string
  items: string[]
}

export default defineSandbox(async (payload: ReleaseNotesPayload = {}): Promise<ReleaseNotesResult> => {
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
Create a discovered Nitro sandbox file:

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vitehub/sandbox'

export type ReleaseNotesPayload = {
  notes?: string
}

export type ReleaseNotesResult = {
  summary: string
  items: string[]
}

export default defineSandbox(async (payload: ReleaseNotesPayload = {}): Promise<ReleaseNotesResult> => {
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

### Call the sandbox from a route

::fw{id="vite:dev vite:build"}
Add a Vite server entry that reads the request body and executes the named sandbox:

```ts [src/server.ts]
import { createError, H3 } from 'h3'
import { readRequestPayload, runSandbox } from '@vitehub/sandbox'
import type { ReleaseNotesPayload } from './release-notes.sandbox'

const app = new H3()

app.post('/api/release-notes', async (event) => {
  const payload = await readRequestPayload<ReleaseNotesPayload>(event, { notes: '' }) as ReleaseNotesPayload
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
Add a Nitro route that reads the request body and executes the named sandbox:

```ts [server/api/release-notes.post.ts]
import { readRequestPayload, runSandbox } from '@vitehub/sandbox'
import type { ReleaseNotesPayload } from '../sandboxes/release-notes'

export default defineEventHandler(async (event) => {
  const payload = await readRequestPayload<ReleaseNotesPayload>(event, { notes: '' }) as ReleaseNotesPayload
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return { result: result.value }
})
```
::

### Verify the response

Run or deploy the app with a configured provider, then send a request:

```bash
curl -X POST http://localhost:3000/api/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added weekly digest\n- Tightened signup copy"}'
```

The route returns the sandbox result:

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

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Run a sandbox
  description: Focus on the route-side call pattern and result handling.
  to: ./guides/run-a-sandbox
  ---
  :::
  :::u-page-card
  ---
  title: Validate payloads
  description: Validate request input before it reaches the sandbox definition.
  to: ./guides/validate-payloads
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare setup
  description: Configure bindings and provider options for Cloudflare.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel setup
  description: Configure credentials and runtime options for Vercel.
  to: ./providers/vercel
  ---
  :::
::
