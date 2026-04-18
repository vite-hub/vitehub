---
title: Run a sandbox
description: Execute a named sandbox and handle the returned result safely.
navigation.title: Run a sandbox
navigation.group: Guides
---

Use `runSandbox()` when you want to execute one named sandbox from a route, task, or server helper.

## Run the common payload-first form

`runSandbox()` takes the discovered sandbox name and an optional payload.

```ts
import { runSandbox } from '@vitehub/sandbox'

const result = await runSandbox('release-notes', {
  notes: '- Added weekly digest',
})
```

The sandbox name comes from the file path, so `release-notes.ts` becomes `release-notes`.

## Handle the result safely

`runSandbox()` returns a result object, so check it before reading the value.

```ts
import { createError } from 'h3'
import { runSandbox } from '@vitehub/sandbox'

const result = await runSandbox('release-notes', {
  notes: '- Added weekly digest',
})

if (result.isErr()) {
  throw createError({
    statusCode: 500,
    statusMessage: result.error.message,
  })
}

return result.value
```

## Pass per-run context

Use the third argument when the handler needs extra caller-scoped context.

```ts
await runSandbox('release-notes', {
  notes: '- Added weekly digest',
}, {
  context: {
    requestId: 'req_123',
    actor: 'docs-bot',
  },
})
```

The `context` object is separate from the payload. Use it for execution metadata that should not become part of the sandbox input contract.

## Know what stays stable

These parts do not change when you switch providers:

- the discovered sandbox name
- the `runSandbox(name, payload, options?)` call site
- the result-checking pattern with `isOk()` and `isErr()`

Provider-specific runtime behavior still changes. Use the provider pages when you need bindings, credentials, or platform limits.

## Related pages

- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
- [Reuse a sandbox](./reuse-a-sandbox)
