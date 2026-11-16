---
title: Realtime configuration
description: Choose the room authority, control saves, and check what each host supports.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Choose a room authority

A room authority holds a document's live Yjs state, and makes sure that every
client of a document edits the same state. Set it with `realtime.authority`
in the ViteHub options in `nuxt.config.ts` or `vite.config.ts`, as in
[Get started](/docs/realtime/get-started#configure-realtime).

| Authority | Use |
| --- | --- |
| `auto` | The default. Uses Cloudflare Durable Objects when the build resolves a Cloudflare host or hosting environment, such as `host: 'cloudflare'`. A Node server uses Redis with `REDIS_URL`, else Postgres with `REALTIME_POSTGRES_URL` or a Postgres Default Database, else `memory`. On the dev server, rooms run in memory. Other production builds fail. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration, for durable, distributed rooms on Cloudflare. On the Vite dev server, it also picks Nitro's Cloudflare dev runtime for the whole app. Rooms still run in memory there. |
| `redis` | Node only. Each instance holds its rooms in memory and shares them with the other instances through Redis pub/sub. Needs `REDIS_URL` when the server starts. |
| `postgres` | Node only. Each instance holds its rooms in memory and shares them through Postgres `LISTEN`/`NOTIFY`. Uses the connection of the Default Database, which must be on Postgres. `REALTIME_POSTGRES_URL` overrides it. |
| `memory` | Keeps rooms in one process, for local development or one Node server. Room state is lost when the process stops. |

With `auto`, a Node server uses Redis when `REDIS_URL` is set. Else it uses
Postgres when the app's Default Database is on Postgres: the bus borrows the
postgres.js client of that Database, so it connects the way the Database
Definition says, whatever variable it reads. `REALTIME_POSTGRES_URL` gives
Realtime its own Postgres instead. Realtime does not read `DATABASE_URL`
itself. The server prints its choice when it starts:

```txt
[vitehub] Realtime shares rooms across instances through Postgres (Default Database).
```

ViteHub rejects the `memory`, `postgres`, and `redis` authorities on other
deploy hosts, and the `cloudflare` authority with a deploy host that is not
Cloudflare.

## Share rooms across Node instances

Run several Node instances behind one load balancer, with a Postgres Default
Database or `REDIS_URL` on each of them. A client on instance A and a client
on instance B then edit the same document and see each other.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    // `server/databases/default.ts` defines the Default Database with `dialect: 'postgresql'`
    database: true,
    realtime: true,
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // `server/databases/default.ts` defines the Default Database with `dialect: 'postgresql'`
      database: true,
      realtime: true,
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // `server/databases/default.ts` defines the Default Database with `dialect: 'postgresql'`
      database: true,
      realtime: true,
    }),
  ],
})
```
:::
::

How it works:

- Each instance keeps the rooms of its own clients in memory. It sends each
  Yjs update and each awareness change to the other instances, and applies
  theirs. No WebSocket needs to reach a special instance, so the load balancer
  does not need sticky sessions.
- The instances start every room from one shared record: the Yjs state at the
  stored digest of the document. Two instances that seed one document alone
  would duplicate its content when their edits merge. The record lives in the
  `vitehub_realtime_rooms` table on Postgres, or in a hash per room on Redis.
- An instance that opens a room loads the document and reads the record under
  the room lock, so it never sees a save of another instance half done. Then it
  asks the other instances for the edits that it does not have yet.
- Saves of one room run one at a time across instances, under a lock: a
  Postgres advisory lock, or a Redis key that expires 30 seconds after its
  holder stops renewing it. Before it saves, an instance takes in the last save
  of the other instances, so its `ifDigest` is the stored digest. After the
  save, the record gets exactly the state that the adapter stored. Edits that
  arrived during the save stay unsaved on every instance, so another instance
  saves them if this one stops. A save with nothing new writes nothing. A
  conflict means that the stored document changed outside the room. The room
  then re-seeds on every instance, as on one instance.
- The Vue and room clients declare their Yjs client id in the WebSocket
  `clientId` query parameter. This lets them reconnect to another instance
  before the old socket closes. Relayed awareness does not transfer ownership.
  Custom y-websocket clients can pass `params: { clientId: String(doc.clientID) }`
  for the same handoff. The server checks the existing user's identity before
  an authenticated handoff. Without the parameter, a stock client can still
  connect and relay awareness. It can claim a remote id after the old owner
  leaves and it sends its next non-null state with a newer clock.
- A client that leaves removes its presence on every instance. An instance that
  stops removes the presence of its clients from the others. An instance that
  crashes sends nothing, so the other instances drop its clients 30 seconds
  after their last awareness update, the Yjs awareness timeout.
- Postgres `NOTIFY` payloads stop at 8,000 bytes. A larger message goes to the
  `vitehub_realtime_messages` table, and the notification carries its id. Rows
  older than 5 minutes are deleted.
- Each app has its own namespace on the bus, so two apps on one Redis or one
  Postgres never share a room, also when both have a document `index.md`. The
  namespace is `realtime.namespace`, else the `name` of `vitehub()`, else the
  `name` in your root `package.json`, else the root folder name.
  `REALTIME_NAMESPACE` replaces it when the server starts, for example to keep
  staging and production apart on one Redis.
- Unsaved edits live in the memory of the instances that have the room open.
  If they all stop at once, the edits since the last save are lost, as with
  `memory`.

Realtime creates its two Postgres tables in the Default Database, or in the
`REALTIME_POSTGRES_URL` database, when it first connects. On the Default
Database, the bus listens on its client and never closes it. A `pg_advisory_xact_lock()` makes the instances create them one at a time.


Postgres Realtime needs a direct connection or a pooler in session mode.
Transaction poolers, including PgBouncer in transaction mode and Neon pooled
connections, do not support `LISTEN`. Realtime does not probe notification
delivery at startup. Use `REALTIME_POSTGRES_URL` with a direct or session-mode
URL when the Default Database uses a transaction pooler. The Default Database
can keep its pooled URL.

Room locks use a separate pool with the same resolved connection settings.
A borrowed Database with `max=1` can still serve adapter queries while a save
holds a lock.

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
| Node, Docker (several instances) | `redis` or `postgres`, which `auto` picks | In the memory of each instance, shared through the bus. | What the document adapter saved, and the shared room record. Unsaved edits survive while an instance keeps the room open, except for a reset after an [interrupted normalizing save](/docs/realtime/server-api#interrupted-normalizing-saves). |
| Node, Docker (one process) | `memory`, which `auto` picks without `REDIS_URL` or a Postgres Default Database | In process memory. | Only what the document adapter saved. Unsaved edits from the last idle window are lost. |
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
  auth: true,
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
| Save lock on Redis | Renewed every 10 seconds while the save runs. It expires 30 seconds after an instance stops. An instance waits at most 30 seconds for it. |

## Inspect definitions

`vitehub inspect definitions` lists each Realtime Definition with its document
adapter, editor codec, identity, authorization, persistence, history, and room
authority. It reads the files without running them.
