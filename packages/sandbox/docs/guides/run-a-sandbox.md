---
title: Run a sandbox
description: Call a discovered sandbox from Vite or Nitro server code and return a safe application response.
navigation.title: Run a sandbox
navigation.group: Guides
navigation.order: 30
icon: i-lucide-play
frameworks: [vite, nitro]
---

This guide focuses on the route-side call. It assumes Sandbox is already registered and a `release-notes` definition exists.

## Call pattern

Every route follows the same shape:

1. Read or build a payload.
2. Call `runSandbox(name, payload)`.
3. Check `result.isErr()`.
4. Return `result.value`.

::fw{id="vite:dev vite:build"}
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

## Pass request context

Use `context` for metadata that should not be part of the business payload:

```ts
const result = await runSandbox('release-notes', payload, {
  context: {
    requestId: event.context.requestId,
  },
})
```

The sandbox receives it as the second argument:

```ts
export default defineSandbox(async (payload: ReleaseNotesPayload = {}, context = {}) => {
  return {
    requestId: context.requestId,
    summary: payload.notes?.split('\n')[0] || '',
  }
})
```

## Verify the route

```bash
curl -X POST http://localhost:3000/api/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added route-side Sandbox call"}'
```

Expected response:

```json
{
  "result": {
    "summary": "Added route-side Sandbox call",
    "items": [
      "Added route-side Sandbox call"
    ]
  }
}
```

## Avoid these mistakes

| Mistake | Fix |
| --- | --- |
| Reading `result.value` before checking `isErr()` | Return or throw from the error branch first. |
| Putting provider logic in the route | Put `provider`, credentials, and bindings in config. |
| Passing raw user input directly | Validate with [Validate payloads](./validate-payloads). |
