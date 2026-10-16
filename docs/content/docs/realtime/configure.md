---
title: Realtime configuration
description: Choose the room authority, control saves, and check what each host supports.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Choose a room authority

A room authority is the one place that holds a document's live Yjs state.
Every client of a document must reach the same authority. Set it with the
`realtime.authority` option of `vitehub()`, as in
[Get started](/docs/realtime/get-started#configure-realtime).

| Authority | Use |
| --- | --- |
| `auto` | Uses Cloudflare Durable Objects when Realtime can resolve a Cloudflare Nitro preset or hosting environment. With only `vitehub({ preset: 'cloudflare' })` during Vite development, set `authority: 'cloudflare'` explicitly. Other development presets use memory; other production builds fail until an authority is selected. |
| `cloudflare` | Generates a SQLite-backed Durable Object binding and migration. Use it for durable, distributed rooms on Cloudflare. |
| `memory` | Keeps rooms in one process. Use it for local development or an explicitly single-process Node deployment. Room state is lost when the process stops. |

ViteHub rejects the memory authority on distributed host presets. It also
rejects a Cloudflare authority paired with another deployment preset.

## Host support

| Host | Authority | Live state | What survives a restart |
| --- | --- | --- | --- |
| Node, Docker (one process) | `memory` | In process memory. | Only what the document adapter saved. Unsaved edits from the last idle window are lost. |
| Cloudflare Workers | `cloudflare` | Nitro's `cloudflare-durable` instance, one room per document, Yjs updates in its SQLite storage. | The full Yjs state, its seed, and whether it was saved. A woken room saves pending edits. |
| Vercel, Netlify, Deno Deploy | none | Not supported. | Builds fail with `REALTIME_B0002` or `REALTIME_B0003`. |

Serverless functions without a shared room cannot run Realtime. Polling a
database for CRDT updates races and loads the database; WordPress removed
HTTP-polling collaboration from 7.0 for those reasons. Use a single-writer
flow, or a Workspace or Content lease, on hosts without an authority.

## Control saves

Realtime saves each room through its document adapter. The default timing
follows Hocuspocus: 2 seconds after the last edit, at most 10 seconds while
editing continues, and immediately when the last client leaves.

```ts [server/realtime/docs.ts]
export default defineRealtime({
  document: { workspace: 'docs' },
  persistence: { debounce: 1_000, maxWait: 5_000 },
})
```

Set `persistence: false` to save only when a client calls `save()` or
`history.checkpoint()`. A memory room with unsaved edits stays in memory and
is not reclaimed.

A failed save writes its message to the room `status` map, keeps the edits,
and retries with backoff up to one minute.

A save that would store the same document writes nothing: when the edits
cancel out, or when the body equals the `canonical` form from the editor's
`verify()`. A room that `verify()` marks read-only never saves. See
[Guard documents the codec cannot keep](/docs/realtime/server-api#guard-documents-the-codec-cannot-keep).

On Cloudflare, idle saves run while the Durable Object is in memory. If it is
evicted with unsaved edits, the edits stay in SQLite and the room saves them
when the next client wakes it.

## Limits

| Boundary | Limit |
| --- | --- |
| WebSocket message | 1 MiB |
| Document updates per client | One per 50 ms; faster clients are disconnected |
| Document state per room | 8 MiB |
| Awareness state per room | 8 MiB |
| Awareness clients per peer | 1,024 |
| Active rooms under the memory authority | 128, with inactive saved rooms reclaimed first |

## Inspect definitions

`vitehub inspect definitions` lists each Realtime Definition with its document
adapter, editor codec, identity, authorization, persistence, history, and room
authority. Inspection reads the definition files statically; it never runs
them.
