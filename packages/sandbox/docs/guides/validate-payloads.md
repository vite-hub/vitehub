---
title: Validate sandbox payloads
description: Validate and normalize payloads before you execute a sandbox.
navigation.title: Validate payloads
navigation.group: Guides
---

Validate payloads before you execute a sandbox so the isolated runtime only sees normalized input.

## Validate input before execution

Use `readValidatedBody(event, validate)` for H3 request bodies. Use `validatePayload(payload, validate)` or `readValidatedPayload(payload, validate)` when the input is already plain data.

::fw{#vite}
```ts [src/run-release-notes.ts]
import { createError, defineEventHandler, readValidatedBody } from 'h3'
import { runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const { notes } = await readValidatedBody(event, (input) => {
    if (!input || typeof input !== 'object' || typeof input.notes !== 'string' || !input.notes.trim()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Enter release notes before running the sandbox.',
      })
    }

    return {
      notes: input.notes.trim(),
    }
  })
  const result = await runSandbox('release-notes', { notes })

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
import { createError, defineEventHandler } from 'h3'
import { readRequestPayload, readValidatedPayload, runSandbox } from '@vitehub/sandbox'

export default defineEventHandler(async (event) => {
  const { notes } = await readValidatedPayload(await readRequestPayload(event), (input) => {
    if (!input || typeof input !== 'object' || typeof input.notes !== 'string' || !input.notes.trim()) {
      throw createError({
        statusCode: 400,
        statusMessage: 'Enter release notes before running the sandbox.',
      })
    }

    return {
      notes: input.notes.trim(),
    }
  })
  const result = await runSandbox('release-notes', { notes })

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

## Normalize once at the edge

Use the validator to:

- reject invalid user input
- trim or coerce values into the shape the sandbox expects
- keep provider-specific execution errors separate from caller-side input errors

## Related pages

- [Run a sandbox](./run-a-sandbox)
- [Runtime API](../runtime-api)
