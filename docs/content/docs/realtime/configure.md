---
title: Realtime configuration
description: Choose the room authority, control saves, and check what each host supports.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Choose a room authority

A room authority holds a document's live Yjs state, and makes sure that every
client of a document edits the same state. Set it with `realtime.authority` in
`vitehub()`, as in [Get started](/docs/realtime/get-started#configure-realtime).

| Authority | Use |
| --- | --- |
| `auto` | The default. Uses Cloudflare Durable Objects when the build resolves a Cloudflare Nitro preset or hosting environment, such as `vitehub({ preset: 'cloudflare' })`. A Node build picks when the server starts: `postgres` or `redis` when their variable is set, else `memory`. On the dev server, rooms run in memory. Other production builds fail. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration, for durable, distributed rooms on Cloudflare. On the Vite dev server, it also picks Nitro's Cloudflare dev runtime for the whole app. Rooms still run in memory there. |
| `redis` | Node only. Each instance holds its rooms in memory and shares them with the other instances through Redis pub/sub. Needs `REDIS_URL` when the server starts. |
| `postgres` | Node only. Each instance holds its rooms in memory and shares them through Postgres `LISTEN`/`NOTIFY`. Needs a `postgres://` `DATABASE_URL` when the server starts. |
| `memory` | Keeps rooms in one process, for local development or one Node server. Room state is lost when the process stops. |

With `auto`, a Node server reads `REDIS_URL` first, then `DATABASE_URL`. It
prints its choice when it starts:

```txt
[vitehub] Realtime shares rooms across instances through Postgres (DATABASE_URL).
```

ViteHub rejects the `memory`, `postgres`, and `redis` authorities on other
deploy presets, and the `cloudflare` authority with a deploy preset that is not
Cloudflare.

## Share rooms across Node instances

Run several Node instances behind one load balancer, and set `REDIS_URL` or a
Postgres `DATABASE_URL` for each of them. A client on instance A and a client
on instance B then edit the same document and see each other.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      realtime: true,
    }),
  ],
})
```

How it works:

- Each instance keeps the rooms of its own clients in memory. It sends each
  Yjs update and each awareness change to the other instances, and applies
  theirs. No WebSocket needs to reach a special instance, so the load balancer
  does not need sticky sessions.
- The instances start every room from one shared record: the Yjs state at the
  stored digest of the document. Two instances that seed one document alone
  would duplicate its content when their edits merge. The record lives in the
  `vitehub_realtime_rooms` table on Postgres, or in a hash per room on Redis.
- An instance that opens a room asks the other instances for the edits that it
  does not have yet.
- Saves of one room run one at a time across instances, under a lock: a
  Postgres advisory lock, or a Redis key with a 30 second expiry. Before it
  saves, an instance takes in the last save of the other instances, so its
  `ifDigest` is the stored digest. The edits of every instance are saved, and
  a save with nothing new writes nothing. A conflict means that the stored
  document changed outside the room. The room then re-seeds on every
  instance, as on one instance.
- A client that leaves removes its presence on every instance. An instance that
  stops removes the presence of its clients from the others. An instance that
  crashes sends nothing, so the other instances drop its clients 30 seconds
  after their last awareness update, the Yjs awareness timeout.
- Postgres `NOTIFY` payloads stop at 8,000 bytes. A larger message goes to the
  `vitehub_realtime_messages` table, and the notification carries its id. Rows
  older than 5 minutes are deleted.
- Unsaved edits live in the memory of the instances that have the room open.
  If they all stop at once, the edits since the last save are lost, as with
  `memory`.

Realtime creates its two Postgres tables when it first connects. A `pg_advisory_xact_lock()` makes the instances create them one at a time.

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
| Node, Docker (several instances) | `redis` or `postgres`, which `auto` picks | In the memory of each instance, shared through the bus. | What the document adapter saved, and the shared room record. Unsaved edits are lost only when every instance with the room stops. |
| Node, Docker (one process) | `memory`, which `auto` picks without `REDIS_URL` or a Postgres `DATABASE_URL` | In process memory. | Only what the document adapter saved. Unsaved edits from the last idle window are lost. |
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
| Active rooms per Node instance | 128, with inactive saved rooms reclaimed first |
| Save lock on Redis | Expires after 30 seconds. A `save()` that takes longer can overlap the next one. |

## Inspect definitions

`vitehub inspect definitions` lists each Realtime Definition with its document
adapter, editor codec, identity, authorization, persistence, history, and room
authority. It reads the files without running them.
