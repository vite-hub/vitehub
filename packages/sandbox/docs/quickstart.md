---
title: Sandbox quickstart
description: Get a first Cloudflare or Vercel sandbox wired into an app.
navigation.title: Quickstart
---

This quickstart wires a `release-notes` sandbox and a route that executes it. Pick Cloudflare or Vercel in app config; local and Docker providers are not part of Sandbox v1.

## Install the package

```bash [Terminal]
pnpm add https://pkg.pr.new/vite-hub/vitehub/@vitehub/sandbox@main
```

Install the provider SDK you use at runtime:

```bash [Terminal]
pnpm add @cloudflare/sandbox
```

```bash [Terminal]
pnpm add @vercel/sandbox
```

## Configure Sandbox

::fw{#vite}
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
::

::fw{#nitro}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    provider: 'cloudflare',
  },
})
```
::

::fw{#nuxt}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
  sandbox: {
    provider: 'cloudflare',
  },
})
```
::

Use `provider: 'vercel'` instead when the app runs on Vercel. Vercel can resolve credentials from explicit config or `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`.

## Define a sandbox

::fw{#vite}
```ts [src/release-notes.sandbox.ts]
import { defineSandbox } from '@vitehub/sandbox'

export default defineSandbox(async (payload?: { notes?: string }) => {
  const notes = typeof payload?.notes === 'string' ? payload.notes.trim() : ''
  const items = notes
    .split(/\n+/)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return {
    summary: items[0] || 'No notes provided.',
    items: items.slice(0, 3),
  }
})
```
::

::fw{#nitro #nuxt}
```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vitehub/sandbox'

export default defineSandbox(async (payload?: { notes?: string }) => {
  const notes = typeof payload?.notes === 'string' ? payload.notes.trim() : ''
  const items = notes
    .split(/\n+/)
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean)

  return {
    summary: items[0] || 'No notes provided.',
    items: items.slice(0, 3),
  }
})
```
::

## Run the sandbox from a route

`runSandbox()` returns a result object, so check for errors before you read the value.

::fw{#vite}
```ts [src/run-release-notes.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ notes: string }>(event)
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({
      statusCode: 500,
      statusMessage: result.error.message,
      data: {
        code: result.error.code,
        provider: result.error.provider,
      },
    })
  }

  return { result: result.value }
})
```
::

::fw{#nitro #nuxt}
```ts [server/api/sandboxes/release-notes.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ notes: string }>(event)
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({
      statusCode: 500,
      statusMessage: result.error.message,
      data: {
        code: result.error.code,
        provider: result.error.provider,
      },
    })
  }

  return { result: result.value }
})
```
::

## Verify that it worked

Deploy or run the app with a configured provider, then send one request:

```bash [Terminal]
curl -X POST https://your-app.example.com/api/sandboxes/release-notes \
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

That response confirms the sandbox file was discovered by name, `runSandbox('release-notes', ...)` resolved the right definition, and the provider returned the normalized `{ result: ... }` contract.

## Next steps

- Use [Run a sandbox](./guides/run-a-sandbox) for the normal execution pattern.
- Use [Validate payloads](./guides/validate-payloads) if this route accepts untrusted input.
- Use [Reuse a sandbox](./guides/reuse-a-sandbox) when the provider should keep identity between runs.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for provider-specific setup.
