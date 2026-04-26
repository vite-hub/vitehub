---
title: Sandbox
description: Run untrusted or expensive code in an isolated provider runtime without changing your application API.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-terminal-square
frameworks: [vite, nitro]
---

`@vitehub/sandbox` gives Vite and Nitro apps one way to define isolated work, call it from your server code, and run it through Cloudflare or Vercel.

Use Sandbox when the code should not run inside the request handler that received the user request. The application keeps a small, typed call site. The provider handles the isolated runtime.

::code-group
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

```ts [server/sandboxes/release-notes.ts]
import { defineSandbox } from '@vitehub/sandbox'

export default defineSandbox(async (payload: { notes?: string } = {}) => {
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

```json [Response]
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

## What Sandbox solves

Inline request code is the simplest option until the work needs isolation, provider-managed runtime resources, or a stable execution boundary.

Sandbox moves that work behind a named definition:

::card-group
  :::card
  ---
  icon: i-lucide-box
  title: Isolated execution
  ---
  Run the definition through a provider sandbox instead of directly in the route handler.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Portable call sites
  ---
  Keep `runSandbox()` calls the same while provider setup stays in framework config.
  :::

  :::card
  ---
  icon: i-lucide-shield-check
  title: Result objects
  ---
  Handle provider and runtime failures with `isOk()` and `isErr()` instead of broad `try` blocks.
  :::

  :::card
  ---
  icon: i-lucide-file-code-2
  title: Discovered definitions
  ---
  Let ViteHub find sandbox files and generate the runtime registry for the active framework.
  :::
::

## One portable flow

The same shape works across providers:

1. Register the Vite plugin or Nitro module.
2. Choose `cloudflare` or `vercel` in `sandbox.provider`.
3. Define a named sandbox with `defineSandbox()`.
4. Call it from server code with `runSandbox(name, payload)`.
5. Check `result.isOk()` or `result.isErr()`.

::callout{icon="i-lucide-info" color="info"}
Provider-specific setup belongs in app config and deployment config. Sandbox definitions and `runSandbox()` calls should stay provider-neutral whenever possible.
::

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers sandbox definitions from `src/**/*.sandbox.ts`.

The sandbox name comes from the path under `src`, without the `.sandbox` suffix. `src/release-notes.sandbox.ts` becomes `release-notes`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers sandbox definitions from `server/sandboxes/**`.

The sandbox name comes from the path under `server/sandboxes`, without the file extension. `server/sandboxes/release-notes.ts` becomes `release-notes`.
::

## Supported providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Cloudflare Sandbox with a Durable Object binding and generated sandbox entrypoint.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel Sandbox with project credentials and Vercel's sandbox runtime.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start here

Start with [Quickstart](./quickstart) for the smallest complete setup. Use the [primitive comparison](../compare) when you are deciding between Sandbox, Queue, inline request code, and other ViteHub primitives.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Define a release-notes sandbox and call it from a route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use typed payloads, context, result handling, and stable sandbox IDs.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, signatures, options, and result types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix provider inference, missing bindings, credentials, and failed executions.
  to: ./troubleshooting
  ---
  :::
::
