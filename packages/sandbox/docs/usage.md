---
title: Sandbox usage
description: Practical patterns for typed payloads, context, result handling, stable sandbox IDs, and portable sandbox call sites.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-workflow
frameworks: [vite, nitro]
---

After the quickstart works, most Sandbox code falls into four patterns: define a typed payload, validate input, call `runSandbox()`, and handle the result object.

## Define payload and result types

Export payload and result types from the sandbox definition when route code needs them.

::fw{id="vite:dev vite:build"}
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
  const items = (payload.notes || '').split('\n').filter(Boolean)
  return { summary: items[0] || '', items }
})
```
::

::fw{id="nitro:dev nitro:build"}
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
  const items = (payload.notes || '').split('\n').filter(Boolean)
  return { summary: items[0] || '', items }
})
```
::

## Keep call sites provider-neutral

The route should not know whether Cloudflare or Vercel is running the sandbox.

```ts
const result = await runSandbox('release-notes', payload)
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    sandbox: {
      provider: 'cloudflare',
      binding: 'SANDBOX',
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    sandbox: {
      provider: 'vercel',
      runtime: 'node22',
    }
    ```
  :::
::

## Pass context separately from payload

Use payload for the data the sandbox operates on. Use `context` for caller metadata.

```ts
const result = await runSandbox('release-notes', payload, {
  context: {
    requestId: event.context.requestId,
    actor: 'docs-admin',
  },
})
```

The sandbox receives that context as its second argument:

```ts
export default defineSandbox(async (payload: ReleaseNotesPayload = {}, context = {}) => {
  return {
    requestId: context.requestId,
    summary: payload.notes?.split('\n')[0] || '',
  }
})
```

## Handle errors before reading values

`runSandbox()` returns a result object. Check it before reading `value`.

```ts
const result = await runSandbox('release-notes', payload)

if (result.isErr()) {
  throw createError({
    statusCode: 500,
    statusMessage: result.error.message,
  })
}

return { result: result.value }
```

This keeps route code explicit and prevents provider/runtime failures from looking like successful application responses.

## Reuse a provider sandbox

Pass `sandboxId` when a provider supports stable sandbox identity:

```ts
const result = await runSandbox('release-notes', payload, {
  sandboxId: 'release-notes-writer',
})
```

Use this only when reuse is intentional. Without a `sandboxId`, Cloudflare execution receives a generated identity for each call.

## Set definition options

Definition options travel with the sandbox:

```ts
export default defineSandbox(async (payload: ReleaseNotesPayload = {}) => {
  return { summary: payload.notes || '' }
}, {
  timeout: 30_000,
  env: {
    NODE_ENV: 'production',
  },
})
```

Use `runtime` only when the default launcher is not enough:

```ts
export default defineSandbox(handler, {
  runtime: {
    command: 'node',
    args: ['entry.mjs'],
  },
})
```

::callout{icon="i-lucide-alert-triangle" color="warning"}
Definition options are extracted during build. Keep them static and JSON-serializable.
::

## Next steps

- Use [Run a sandbox](./guides/run-a-sandbox) for route examples.
- Use [Validate payloads](./guides/validate-payloads) before passing user input to a sandbox.
- Use [Runtime API](./runtime-api) for exact option names.
