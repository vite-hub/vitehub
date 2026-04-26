---
title: Validate payloads
description: Validate request payloads before passing them to a sandbox definition.
navigation.title: Validate payloads
navigation.group: Guides
navigation.order: 31
icon: i-lucide-shield-check
frameworks: [vite, nitro]
---

Validate user input before it crosses the sandbox boundary. The route should pass a shaped payload to `runSandbox()`, not whatever the client sent.

## Validate after reading the body

```ts
import { readRequestPayload, readValidatedPayload } from '@vitehub/sandbox'

const body = await readRequestPayload(event, { notes: '' })
const payload = await readValidatedPayload(body, (value) => {
  if (!value || typeof value !== 'object') return false

  return {
    notes: String((value as { notes?: unknown }).notes || ''),
  }
})
```

Then call the sandbox:

```ts
const result = await runSandbox('release-notes', payload)
```

## Use a function validator

A function validator can:

- return `true` to keep the original value
- return `false` to fail validation
- return a transformed value
- throw an error to fail validation

```ts
const payload = await readValidatedPayload(body, (value) => {
  if (!value || typeof value !== 'object') return false

  const notes = String((value as { notes?: unknown }).notes || '').trim()
  if (!notes) return false

  return { notes }
})
```

## Customize validation errors

Use `onError` when you need a route-specific error shape:

```ts
const payload = await readValidatedPayload(body, validateReleaseNotes, {
  onError() {
    return createError({
      statusCode: 400,
      statusMessage: 'Expected a non-empty notes field.',
    })
  },
})
```

## Use `validatePayload`

`validatePayload` is an alias for `readValidatedPayload`.

```ts
import { validatePayload } from '@vitehub/sandbox'

const payload = await validatePayload(body, validateReleaseNotes)
```

## Full route

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { createError, H3 } from 'h3'
import { readRequestPayload, readValidatedPayload, runSandbox } from '@vitehub/sandbox'

const app = new H3()

app.post('/api/release-notes', async (event) => {
  const body = await readRequestPayload(event, { notes: '' })
  const payload = await readValidatedPayload(body, (value) => {
    if (!value || typeof value !== 'object') return false
    return { notes: String((value as { notes?: unknown }).notes || '') }
  })

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
import { readRequestPayload, readValidatedPayload, runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const body = await readRequestPayload(event, { notes: '' })
  const payload = await readValidatedPayload(body, (value) => {
    if (!value || typeof value !== 'object') return false
    return { notes: String((value as { notes?: unknown }).notes || '') }
  })

  const result = await runSandbox('release-notes', payload)
  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return { result: result.value }
})
```
::
