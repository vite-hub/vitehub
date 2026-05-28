---
title: Server primitives for any host
description: >-
  See the ViteHub API for Env, KV, Blob, DB, Queue, Workflow, Schedule,
  Sandbox, and Workspace in one framework-aware walkthrough.
date: 2026-05-28
image: /images/tutorials/server-primitives-flat.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
navigation.title: Server primitives
navigation.order: 2
icon: i-lucide-blocks
frameworks: [vite, nitro]
---

This post is a quick tour of the ViteHub API.

You will not add every primitive to one app on day one. The point is to see the
developer experience: register the integration, define the work when the
primitive needs a file, then call a small Runtime Helper from server code.

The provider can change later. The application code should still be easy to
read.

## Install the primitives

Install the packages you want to try:

```bash [Terminal]
pnpm add @vitehub/env @vitehub/kv @vitehub/blob
pnpm add @vitehub/queue @vitehub/workflow @vitehub/schedule
pnpm add @vitehub/sandbox @vitehub/workspace
```

::fw{id="vite:dev vite:build"}
DB is currently documented for Vite. Add it when you want Drizzle database
definitions:

```bash [Terminal]
pnpm add @vitehub/database drizzle-orm
```
::

## Register the integrations

Start with config. This is where provider choices belong.

::fw{id="vite:dev vite:build"}
::code-tree-intersection{default}
```ts [vite.config.ts]
import { hubBlob } from '@vitehub/blob/vite'
import { hubDb } from '@vitehub/database/vite'
import { env, envVite } from '@vitehub/env/vite'
import { hubKv } from '@vitehub/kv/vite'
import { hubQueue } from '@vitehub/queue/vite'
import { hubSandbox } from '@vitehub/sandbox/vite'
import { hubSchedule } from '@vitehub/schedule/vite'
import { hubWorkflow } from '@vitehub/workflow/vite'
import { hubWorkspace } from '@vitehub/workspace/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    envVite({ prefix: 'VITEHUB_' }),
    hubKv(),
    hubBlob(),
    hubDb(),
    hubQueue(),
    hubWorkflow(),
    hubSchedule(),
    hubSandbox(),
    hubWorkspace(),
  ],
  env: {
    public: {
      appName: env({ default: 'ViteHub App', mode: 'build' }),
    },
  },
  blob: {
    driver: 'fs',
    base: '.data/blob',
  },
  queue: { provider: 'cloudflare' },
  workflow: { provider: 'cloudflare' },
  sandbox: { provider: 'cloudflare' },
})
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection{default}
```ts [nitro.config.ts]
import { env, envNitro } from '@vitehub/env/nitro'
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [
    envNitro(),
    '@vitehub/kv/nitro',
    '@vitehub/blob/nitro',
    '@vitehub/queue/nitro',
    '@vitehub/workflow/nitro',
    '@vitehub/schedule/nitro',
    '@vitehub/sandbox/nitro',
    '@vitehub/workspace/nitro',
  ],
  env: {
    auth: {
      token: env({ secret: true }),
    },
  },
  blob: {
    driver: 'fs',
    base: '.data/blob',
  },
  queue: { provider: 'cloudflare' },
  workflow: { provider: 'cloudflare' },
  sandbox: { provider: 'cloudflare' },
})
```
::
::

The rest of the post uses the same pattern again and again. Definitions live in
files ViteHub can discover. Runtime Helpers are what your routes or server
functions call.

## Env keeps config explicit

Use Env when you want typed public values and server-only secrets instead of
scattered environment reads.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/main.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()

document.querySelector('#app')!.textContent = publicEnv.appName
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [server/api/config.get.ts]
import { useServerEnv } from '#vitehub/env/server'
import { defineEventHandler } from 'h3'

export default defineEventHandler((event) => {
  const env = useServerEnv(event)

  return {
    hasAuthToken: Boolean(env.auth.token.unseal()),
  }
})
```
::
::

The important part is the boundary. Public Env is safe to expose. Server Env
can hold secrets.

## KV stores small state

Use KV for settings, flags, cache entries, and small JSON-like records.

::code-tree-intersection
```ts [server/api/settings.put.ts]
import { kv } from '@vitehub/kv'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const settings = await readBody(event)

  await kv.set('settings', settings)

  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'
import { defineEventHandler } from 'h3'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```
::

The same `kv` handle can point at local storage, Cloudflare KV, or an
Upstash-backed Vercel setup.

## Blob stores files

Use Blob when the data is a file, an upload, a generated asset, or a stream.

::code-tree-intersection
```ts [server/api/notes.put.ts]
import { blob } from '@vitehub/blob'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string }>(event)

  return await blob.put('notes/welcome.txt', body.text || 'hello world', {
    contentType: 'text/plain; charset=utf-8',
  })
})
```

```ts [server/api/notes.get.ts]
import { blob } from '@vitehub/blob'
import { defineEventHandler } from 'h3'

export default defineEventHandler(async () => {
  return await blob.list({ prefix: 'notes', limit: 10 })
})
```
::

The route cares about pathnames and content. The integration decides whether the
file lands on disk, in Cloudflare R2, or in Vercel Blob.

## DB defines app data

Use DB when the data has tables, relations, joins, or history.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [server/databases/config.ts]
import { defineDatabase } from '@vitehub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

```ts [server/api/notes.post.ts]
import { db, schema } from '@vitehub/database/drizzle'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title: string }>(event)

  await db.insert(schema.notes).values({ title: body.title })

  return { ok: true }
})
```
::
::

::fw{id="nitro:dev nitro:build"}
DB is the one primitive in this tour that is currently documented for Vite
only. For Nitro, use the same idea when the Nitro integration lands: keep the
database definition separate from the route code that uses it.
::

## Queue moves work out of the request

Use Queue when the request should return before the work finishes.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export type WelcomeEmailPayload = {
  email: string
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```
::
::

::code-tree-intersection
```ts [server/api/signup.post.ts]
import { runQueue } from '@vitehub/queue'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  const result = await runQueue('welcome-email', payload)

  return { ok: true, result }
})
```
::

The queue name comes from the file path. The producer only needs
`runQueue('welcome-email', payload)`.

## Workflow keeps a long task visible

Use Workflow when a background operation has steps, a run id, or a result you
want to inspect later.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/welcome.workflow.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload }) => {
  return {
    id,
    message: `Welcome ${payload.email}`,
  }
})
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload }) => {
  return {
    id,
    message: `Welcome ${payload.email}`,
  }
})
```
::
::

::code-tree-intersection
```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vitehub/workflow'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ email: string }>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, run }
})
```
::

Queue is for delivery. Workflow is for orchestration.

## Schedule runs recurring work

Use Schedule for cron-shaped work such as reports, cleanup, sync, and
maintenance jobs.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/daily-report.schedule.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule({
  cron: '0 9 * * *',
  handler: async (context) => {
    console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
  },
})
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [server/schedules/daily-report.ts]
import { defineSchedule } from '@vitehub/schedule'

export default defineSchedule({
  cron: '0 9 * * *',
  handler: async (context) => {
    console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
  },
})
```
::
::

The cron and the handler live together. Provider builds can turn discovered
static schedules into provider cron output.

## Sandbox isolates execution

Use Sandbox when code should run away from the request handler. This is useful
for transforms, code execution, and agent tools that need a stronger boundary.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/release-notes.sandbox.ts]
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
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
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
::
::

::code-tree-intersection
```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vitehub/sandbox'
import { createError, defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const payload = await readBody<{ notes: string }>(event)
  const result = await runSandbox('release-notes', payload)

  if (result.isErr()) {
    throw createError({ statusCode: 500, statusMessage: result.error.message })
  }

  return result.value
})
```
::

The route handles product input. The sandbox owns the isolated work.

## Workspace gives files a home

Use Workspace when a feature needs a named file tree: docs, imported sources,
generated artifacts, or files an Agent can inspect.

::fw{id="vite:dev vite:build"}
::code-tree-intersection
```ts [src/docs.workspace.ts]
import { defineWorkspace, source } from '@vitehub/workspace'

export default defineWorkspace({
  sources: {
    readme: source.file('README.md'),
  },
})
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection
```ts [server/workspaces/docs.ts]
import { defineWorkspace, source } from '@vitehub/workspace'

export default defineWorkspace({
  sources: {
    readme: source.file('README.md'),
  },
})
```
::
::

::code-tree-intersection
```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vitehub/workspace'
import { defineEventHandler } from 'h3'

export default defineEventHandler(async () => {
  const workspace = useWorkspace('docs')

  return {
    files: await workspace.fs.list('', { recursive: true }),
    readme: await workspace.fs.readFile('README.md'),
  }
})
```
::

Workspace is the bridge between the server primitives and agents. The next post
uses a colocated Workspace Source so an Agent can answer from project files.

## The files move, the API stays

The framework selector at the top of this page changes the setup and discovery
paths:

- Vite definitions usually live in `src/*.queue.ts`, `src/*.workflow.ts`,
  `src/*.schedule.ts`, `src/*.sandbox.ts`, and `src/*.workspace.ts`.
- Nitro definitions live under `server/queues/**`, `server/workflows/**`,
  `server/schedules/**`, `server/sandboxes/**`, and `server/workspaces/**`.

The body of the definition barely changes. That is the part I care about. You
learn the ViteHub primitive once, then place it where the framework expects it.

## What to remember

The API is intentionally repetitive:

- register the integration
- define named work when the primitive needs discovery
- keep Provider Selection in config
- call Runtime Helpers from server code

That repetition is the developer experience. Once you understand one primitive,
the next one should feel familiar.

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Introducing ViteHub
  description: Read the project direction and why the primitive layer exists.
  icon: i-lucide-network
  to: ./introducing-vitehub
  ---
  :::
  :::u-page-card
  ---
  title: Build an AI Agent in one file
  description: Compose Agent behavior, Capabilities, Workspace, DevTools, and evals.
  icon: i-lucide-message-circle-code
  to: ./build-ai-chatbot
  ---
  :::
::
