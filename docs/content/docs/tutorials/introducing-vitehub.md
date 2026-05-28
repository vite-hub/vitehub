---
title: Introducing ViteHub
description: >-
  Server primitives for Vite and Nitro apps with good defaults, typed APIs, and
  provider choice.
date: 2026-05-28
image: /images/tutorials/vitehub-intro-flat.png
authors:
  - name: onmax
    avatar:
      src: https://github.com/onmax.png
    to: https://github.com/onmax
navigation.title: Introducing ViteHub
navigation.order: 1
icon: i-lucide-network
frameworks: [vite, nitro]
---

Building full-stack apps in JavaScript should not mean relearning the same
server feature every time you change host.

You want the feeling Nuxt developers already know: add the module, get useful
defaults, keep the API typed, and still have room to choose the provider that
fits the project. ViteHub is my attempt to bring that developer experience to
Vite and Nitro server features.

The goal is small: keep application code focused on the feature, and move
provider wiring to the integration boundary.

::fw{id="vite:dev vite:build"}
::code-tree-intersection{default}
```ts [vite.config.ts]
import { hubKv } from '@vitehub/kv/vite'
import { hubQueue } from '@vitehub/queue/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubKv(),
    hubQueue(),
  ],
  queue: {
    provider: 'cloudflare',
  },
})
```

```ts [src/welcome-email.queue.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```

```ts [server/features/signup.ts]
import { kv } from '@vitehub/kv'
import { runQueue } from '@vitehub/queue'

export async function createSignup(email: string) {
  const userId = crypto.randomUUID()

  await kv.set(`users:${userId}`, { email })
  await runQueue('welcome-email', { email })

  return { userId, queued: true }
}
```
::
::

::fw{id="nitro:dev nitro:build"}
::code-tree-intersection{default}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [
    '@vitehub/kv/nitro',
    '@vitehub/queue/nitro',
  ],
  queue: {
    provider: 'cloudflare',
  },
})
```

```ts [server/queues/welcome-email.ts]
import { defineQueue } from '@vitehub/queue'

export default defineQueue<{ email: string }>(async (job) => {
  console.log(`Send welcome email to ${job.payload.email}`)
})
```

```ts [server/features/signup.ts]
import { kv } from '@vitehub/kv'
import { runQueue } from '@vitehub/queue'

export async function createSignup(email: string) {
  const userId = crypto.randomUUID()

  await kv.set(`users:${userId}`, { email })
  await runQueue('welcome-email', { email })

  return { userId, queued: true }
}
```
::
::

The queue definition and the feature code do not know whether the job runs on
Cloudflare, Vercel, or a local development driver. That choice belongs in
Integration Options because it changes provider output, bindings, and runtime
setup.

## Why this exists

The frontend side of the JavaScript ecosystem feels very far ahead. Vite,
Nuxt, and the surrounding tools give us fast feedback loops and a clear way to
compose features.

Server work still feels more fragmented. Uploads, key-value state, scheduled
jobs, queues, workflows, sandboxes, and AI agents often start with a provider
SDK. That works, but it leaks infrastructure into every route and makes local
development, testing, and migration harder than they should be.

ViteHub tries to make those server features feel ordinary:

- define the work in a small file
- register the Vite Integration or Nitro Integration
- choose the provider in config
- use one Runtime Helper from application code
- inspect the behavior locally before deploying

Provider-neutral does not mean provider-blind. Cloudflare and Vercel are not
the same platform. ViteHub keeps the differences explicit, but it avoids making
every application file speak the provider SDK.

## The influences

This project did not come from nowhere.

[Nuxt Hub](https://hub.nuxt.com/) made the direction feel real: full-stack
features can have good defaults without pretending storage, deployment, and
runtime details do not exist. [UnJS](https://unjs.io/) is the package
philosophy I keep coming back to: focused libraries, portable runtime pieces,
and clear boundaries instead of one giant framework runtime.

[Better Auth](https://better-auth.com/) influenced the developer experience on
top. A serious feature can still be configured from one typed file, with
plugins or capabilities added only when the application needs them.

ViteHub applies those ideas to server primitives first, then to agents.

## Two layers

The first layer is server primitives for any host:

- Env for typed build-time and runtime configuration
- KV for key-value state
- Blob for file-shaped data
- DB for Drizzle database definitions
- Queue for provider-delivered background work
- Workflow for durable orchestration
- Schedule for recurring cron work
- Sandbox for isolated execution
- Workspace for persistent file-tree state and source ingestion

Each package owns one job. The Definition stays portable. The framework
integration discovers it, generates the Runtime Registry or provider output it
needs, and exposes a small Runtime Helper for application code.

The second layer is the Agent Package. Agents build on the primitives instead
of replacing them. An Agent owns model behavior, Capabilities expose explicit
abilities, and Workspaces provide the source context an agent can inspect.

## What this gives you

For a product team, the practical value is not the architecture diagram. It is
the smaller pull request.

You can review a feature by opening a few files: the Definition, the framework
config, and the route that calls it. You can see whether a job is a Queue, a
Workflow, or inline request code. You can see whether the provider choice lives
in config instead of being scattered across handlers.

That also makes the project easier to change. Start local. Deploy to
Cloudflare. Try Vercel. Move one primitive at a time. Keep the application code
stable when the host changes.

## Where it is going

ViteHub is still early, and that is the point of writing this now. The
foundation is useful enough to build with, but the project needs more hands:

- more provider coverage
- stronger tests across Vite, Nitro, Cloudflare, and Vercel
- better examples for real product flows
- faster and clearer documentation
- more feedback from people building serious server features

The next post goes deeper into the first layer: server primitives for any host.
After that, we will use those ideas to build an AI Agent in one file.

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Server primitives for any host
  description: Understand the storage, workflow, sandbox, and workspace layer.
  icon: i-lucide-blocks
  to: ./server-primitives-any-host
  ---
  :::
  :::u-page-card
  ---
  title: Build an AI Agent in one file
  description: Compose model behavior, Capabilities, and Workspace Sources.
  icon: i-lucide-message-circle-code
  to: ./build-ai-chatbot
  ---
  :::
::
