---
title: Realtime configuration
description: Choose the room authority, control saves, and check what each host supports.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Choose a room authority

A room authority is the one place that holds a document's live Yjs state.
Every client of a document must reach the same authority. Set it with
`realtime.authority` in the ViteHub options in `nuxt.config.ts` or
`vite.config.ts`, as in
[Get started](/docs/realtime/get-started#configure-realtime).

| Authority | Use |
| --- | --- |
| `auto` | Uses Cloudflare Durable Objects when the build resolves a Cloudflare Nitro preset or hosting environment, such as `vitehub({ host: 'cloudflare' })`. Other production builds fail until you pick an authority. On the dev server, rooms run in memory. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration, for durable, distributed rooms on Cloudflare. On the Vite dev server, it also picks Nitro's Cloudflare dev runtime for the whole app. Rooms still run in memory there. |
| `memory` | Keeps rooms in one process, for local development or a single-process Node deploy. Room state is lost when the process stops. |

ViteHub rejects the memory authority on distributed hosts, and a
Cloudflare authority with another deploy host.

## Develop locally

The dev server holds rooms in its own process, with every authority. Nitro's
Cloudflare dev runtime reads your own wrangler config, which lacks the
generated `$DurableObject` binding, so the room handler opens memory rooms.
Auth, `authorize()`, and document adapters run as in production. To test
Durable Objects, build and run the output with
`npx wrangler dev --config .output/server/wrangler.json`.

Room WebSockets need a dev server that passes upgrade requests to Nitro, as
`vite dev` does. Some `nuxt dev` CLI versions give Vite no HTTP server, so
upgrades never reach Nitro. There, build and preview to test rooms.

## Host support

| Host | Authority | Live state | What survives a restart |
| --- | --- | --- | --- |
| Node, Docker (one process) | `memory` | In process memory. | Only what the document adapter saved. Unsaved edits from the last idle window are lost. |
| Cloudflare Workers | `cloudflare` | One Durable Object per document, with Yjs updates in its SQLite storage. | The full Yjs state, its seed, and whether it was saved. A woken room saves pending edits. |
| Vercel, Netlify, Deno Deploy | none | Not supported. | Builds with Realtime on fail with `REALTIME_MISSING_AUTHORITY` or `REALTIME_AUTHORITY_CONFLICT`. |

Serverless functions without a shared room cannot run Realtime. Polling a
database for CRDT updates causes races and load. WordPress removed
HTTP-polling collaboration from 7.0 for those reasons. On hosts without an
authority, use a single-writer flow, or a Workspace or Content lease.

## Builds without Realtime

An app that deploys to several hosts can import `vite-hub/realtime/server`
on every host. A build without Realtime still works but has no rooms, so
`refreshRealtimeDocument()` resolves `false`. Call `isRealtimeAvailable()` to
turn off features that need rooms:

```ts [server/api/drafts/[id].post.ts]
import { defineEventHandler } from 'h3'
import { isRealtimeAvailable } from 'vite-hub/realtime/server'

export default defineEventHandler(() => {
  if (!isRealtimeAvailable()) return new Response('Live editing is off on this host.', { status: 404 })
  // Open the draft for its room.
})
```

`isRealtimeAvailable()` returns `true` in a build with a room authority, and
on the dev server.

## Control saves

Realtime saves each room through its document adapter. The defaults follow
Hocuspocus: 2 seconds after the last edit, at most 10 seconds while edits
continue, and at once when the last client leaves.

```ts [server/realtime/docs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: { workspace: 'docs' },
  persistence: { debounce: 1_000, maxWait: 5_000 },
})
```

- `persistence: false` saves only when a client calls `save()` or
  `history.checkpoint()`. A memory room with unsaved edits stays in memory and
  is not reclaimed.
- A failed save writes its message to the room `status` map, keeps the edits,
  and retries with backoff up to one minute.
- A save writes nothing when the document is unchanged: the edits cancel out,
  or the body equals the `canonical` form from the editor's `verify()`. A room that `verify()` marks read-only never saves
  ([Guard documents the codec cannot keep](/docs/realtime/server-api#guard-documents-the-codec-cannot-keep)).
- On Cloudflare, idle saves run while the Durable Object is in memory. If it
  is evicted with unsaved edits, they stay in SQLite until the next client
  wakes the room and it saves them.

## Limits

| Boundary | Limit |
| --- | --- |
| WebSocket message | 1 MiB |
| Document updates per client | Bursts of 40, refilled at 20 per second. A client that keeps sending faster is disconnected. |
| Document state per room | 8 MiB |
| Awareness state per room | 8 MiB |
| Awareness clients per peer | 1,024 |
| Active rooms under the memory authority | 128, with inactive saved rooms reclaimed first |

## Inspect definitions

`vitehub inspect definitions` lists each Realtime Definition with its document
adapter, editor codec, identity, authorization, persistence, history, and room
authority. It reads the files without running them.
