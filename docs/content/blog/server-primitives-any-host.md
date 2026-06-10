---
title: Server primitives for any host
description: >-
  See the ViteHub API for Env, KV, Blob, DB, Queue, Workflow, Schedule,
  Sandbox, and Workspace in one Vite-first walkthrough.
date: 2026-05-28
category: Article
layout: tutorial
image: /images/tutorials/server-primitives-flat.png
authors:
  - name: maxi
    description: "@onmax"
    avatar:
      src: https://github.com/onmax.png
    target: _blank
    to: https://github.com/onmax
icon: i-lucide-blocks
---

This post is a quick tour of the ViteHub API.

You will not add every primitive to one app on day one. The point is to see the
developer experience: register the Vite Integration, define the work when the
primitive needs a file, then call a small Runtime Helper from server code.

The provider can change later. The application code should still be easy to
read.

## Install the primitives

Install the packages you want to try:

```bash [Terminal]
pnpm add @vite-hub/env @vite-hub/kv @vite-hub/blob
pnpm add @vite-hub/queue @vite-hub/workflow @vite-hub/schedule
pnpm add @vite-hub/sandbox @vite-hub/workspace
```

Database is currently documented for Vite. Add it when you want Drizzle database
definitions:

```bash [Terminal]
pnpm add @vite-hub/database drizzle-orm
```

## Register Vite Integrations

Start with config. This is where provider choices belong.

::code-tree-intersection{default}
```ts [vite.config.ts]
import { hubBlob } from '@vite-hub/blob/vite'
import { hubDb } from '@vite-hub/database/vite'
import { env, envVite } from '@vite-hub/env/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { hubQueue } from '@vite-hub/queue/vite'
import { hubSandbox } from '@vite-hub/sandbox/vite'
import { hubSchedule } from '@vite-hub/schedule/vite'
import { hubWorkflow } from '@vite-hub/workflow/vite'
import { hubWorkspace } from '@vite-hub/workspace/vite'
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

The rest of the post uses the same pattern again and again. Definitions live in
files ViteHub can discover. Runtime Helpers are what your routes or server
functions call.

## Env keeps config explicit

Use Env when you want typed public values and server-only secrets instead of
scattered environment reads.

::code-tree-intersection
```ts [src/main.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()

document.querySelector('#app')!.textContent = publicEnv.appName
```
::

The important part is the boundary. Public Env is safe to expose. Server-only
secrets stay in the host runtime and never move through build-time public env.

## KV stores small state

Use KV for settings, flags, cache entries, and small JSON-like records.

::code-tree-intersection
```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const settings = await readBody(event)

  await kv.set('settings', settings)

  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'
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
import { blob } from '@vite-hub/blob'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ text?: string }>(event)

  return await blob.put('notes/welcome.txt', body.text || 'hello world', {
    contentType: 'text/plain; charset=utf-8',
  })
})
```

```ts [server/api/notes.get.ts]
import { blob } from '@vite-hub/blob'
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

::code-tree-intersection
```ts [server/db/schema.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

export default defineDatabase({
  schema: { notes },
})
```

```ts [server/api/notes.post.ts]
import { db, schema } from '@vite-hub/database/drizzle'
import { defineEventHandler, readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title: string }>(event)

  await db.insert(schema.notes).values({ title: body.title })

  return { ok: true }
})
```
::

## Queue moves work out of the request

Use Queue when the request should return before the work finishes.

::code-tree-intersection
```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vite-hub/queue'

export type WelcomeEmailPayload = {
  email: string
}

export default defineQueue<WelcomeEmailPayload>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```
::

::code-tree-intersection
```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'
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

::code-tree-intersection
```ts [src/welcome.workflow.ts]
import { defineWorkflow } from '@vite-hub/workflow'

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

::code-tree-intersection
```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vite-hub/workflow'
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

::code-tree-intersection
```ts [src/daily-report.schedule.ts]
import { defineSchedule } from '@vite-hub/schedule'

export default defineSchedule({
  cron: '0 9 * * *',
  async run(context) {
    console.log(`Run daily report at ${context.scheduledAt.toISOString()}`)
  },
})
```
::

The cron and the handler live together. Provider builds can turn discovered
static schedules into provider cron output.

## Sandbox isolates execution

Use Sandbox when code should run away from the request handler. This is useful
for transforms, code execution, and agent tools that need a stronger boundary.

::code-tree-intersection
```ts [src/release-notes.sandbox.ts]
import { defineSandbox } from '@vite-hub/sandbox'

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

::code-tree-intersection
```ts [server/api/release-notes.post.ts]
import { runSandbox } from '@vite-hub/sandbox'
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

::code-tree-intersection
```ts [src/docs.workspace.ts]
import { defineWorkspace, source } from '@vite-hub/workspace'

export default defineWorkspace({
  sources: {
    readme: source.glob({
      cwd: '.',
      include: ['README.md'],
    }),
  },
})
```
::

::code-tree-intersection
```ts [server/api/docs.get.ts]
import { useWorkspace } from '@vite-hub/workspace'
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

The examples above use Vite-discovered files such as `src/*.queue.ts`,
`src/*.workflow.ts`, `src/*.schedule.ts`, `src/*.sandbox.ts`, and
`src/*.workspace.ts`. Server routes call the stable Runtime Helpers from the
code that handles product input.

The body of each definition stays small. That is the part I care about. You
learn the ViteHub primitive once, then place the definition where ViteHub can
discover it.

## What to remember

The API is intentionally repetitive:

- register the Vite Integration
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
  to: /blog/introducing-vitehub
  ---
  :::
  :::u-page-card
  ---
  title: Build an AI Agent in one file
  description: Compose Agent behavior, Capabilities, Workspace, DevTools, and evals.
  icon: i-lucide-message-circle-code
  to: /blog/build-ai-chatbot
  ---
  :::
::
