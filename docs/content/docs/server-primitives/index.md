---
title: Server primitives
description: Use ViteHub primitives directly in app and server code without creating agents.
navigation.title: Overview
navigation.order: 10
icon: i-lucide-server-cog
---

Server primitives are the ViteHub features you can use without agents. They give app code a stable API for storage, runtime work, source files, schedules, isolated execution, and environment values.

Each primitive owns one job. You can combine them, but you should not treat them as one hidden platform runtime.

## Primitive map

| Primitive | Use it for |
| --- | --- |
| [Env](/docs/server-primitives/env) | Typed public and server-only runtime values. |
| [KV](/docs/server-primitives/kv) | Small values addressed by key. |
| [Database](/docs/server-primitives/database) | Relational or durable application models. |
| [Blob](/docs/server-primitives/blob) | File-shaped objects, uploads, generated artifacts, and metadata. |
| [Workspace and Sources](/docs/server-primitives/workspace) | Persistent file trees, source ingestion, snapshots, and diffs. |
| [Queue](/docs/server-primitives/queue) | Background delivery outside the request path. |
| [Workflow](/docs/server-primitives/workflow) | Durable orchestration with steps, waits, retries, and run state. |
| [Schedule](/docs/server-primitives/schedule) | Future and recurring runtime work. |
| [Sandbox](/docs/server-primitives/sandbox) | Isolated command and code execution. |

## How primitives fit together

ViteHub keeps setup at the app boundary and keeps application code small. The app chooses the primitive first, then chooses host-specific configuration only where that primitive needs it.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  await kv.set('settings', body)
  return { ok: true }
})
```

That route does not know whether the backing store is local, Cloudflare, Vercel, or another driver. The Runtime Helper stays stable.

## Definitions and Runtime Helpers

Some primitives are just runtime handles. KV, Blob, and Env can often be used directly once configured.

Other primitives need Definitions. A Queue worker, Workflow, Schedule target, Sandbox task, Workspace, Agent, or Database schema is declared in a file and discovered by the integration.

Read [Definitions and discovery](/docs/server-primitives/definitions) when you need to understand naming, file locations, generated registries, and why discovered names come from location instead of arbitrary inline ids.

## Host behavior lives with the feature

There is no standalone host documentation path. Cloudflare, Vercel, local development, and other host details belong inside the primitive page they affect.

For example, KV explains Cloudflare namespaces and Vercel-compatible credentials because the driver and credentials differ. Workflow explains generated host output because orchestration output differs. Those details should stay close to the primitive instead of becoming a separate product concept.
