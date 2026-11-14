---
title: Realtime limits and errors
description: Handle Realtime request errors by code, read room close codes, and repair Realtime configuration.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle request errors

`save()`, `history.checkpoint()`, and `refresh()` of `useRealtimeTiptap()` return `[error, data]`. When `error` is set, `error.code` names the failure, `error.why` says what went wrong, `error.fix` says what to do, and `error.docs` links to the code in [Realtime diagnostics](/docs/realtime/diagnostics).

```ts [app/components/PageEditor.vue] fragment
const realtime = useRealtimeTiptap('pages', () => props.path)
const toast = useToast()

async function publish() {
  const [error, checkpoint] = await realtime.history.checkpoint()
  if (error) {
    toast.add({ title: 'Not published', description: error.why })
    return
  }
  toast.add({ title: `Published ${checkpoint.snapshot.id}` })
}
```

`error.code` has the type `RealtimeRequestErrorCode`. The composable retries `409` answers with `REALTIME_SYNC_PENDING` before it returns an error.

Room errors happen after the WebSocket opens, so the server closes the connection with a close code. Configuration and build errors throw.

| Code | Where |
| --- | --- |
| `REALTIME_DISABLED`, `REALTIME_DISCONNECTED`, `REALTIME_INVALID_RESPONSE`, `REALTIME_MISSING_DOCUMENT`, `REALTIME_REQUEST_FAILED` | Returned by `save()`, `history.checkpoint()`, and `refresh()` |
| `REALTIME_AWARENESS_OWNERSHIP_CONFLICT` | WebSocket close code `4500` |
| `REALTIME_AWARENESS_TOO_LARGE`, `REALTIME_DOCUMENT_TOO_LARGE`, `REALTIME_INVALID_AWARENESS`, `REALTIME_TOO_MANY_AWARENESS_CLIENTS` | WebSocket close code `4400` |
| `REALTIME_DOCUMENT_CONFLICT` | Thrown by a document adapter. The room re-seeds and clients reset. |
| `REALTIME_MISSING_ACCESS`, `REALTIME_INVALID_ACCESS`, `REALTIME_CHECKPOINT_UNSUPPORTED` | Thrown by `defineRealtime()` and when the server loads the definition |
| `REALTIME_INVALID_PERSISTENCE`, `REALTIME_INVALID_USER`, `REALTIME_MISSING_DIGEST` | Thrown on the server when a room opens or saves |
| `REALTIME_AUTHORITY_CONFLICT`, `REALTIME_MISSING_AUTHORITY` | Thrown when Vite reads the config |

## Limits

- One WebSocket message is at most 1 MiB.
- Document state and awareness state (who is here, and their cursors) are each at most 8 MiB per room.
- One peer can own at most 1,024 awareness clients.
- One process keeps at most 128 active rooms, also when Node instances share rooms.

## Request errors

### REALTIME_DISABLED

The composable has `enabled: false`, so the request did not run.

### REALTIME_DISCONNECTED

The document changed, the composable was disabled or destroyed, or its scope stopped during the request. Call the method again after the new document connects.

### REALTIME_INVALID_RESPONSE

The client cannot use the server's answer. Use the same `@vite-hub/realtime` version on client and server.

### REALTIME_MISSING_DOCUMENT

`documentId` of `useRealtimeTiptap()` is empty.

### REALTIME_REQUEST_FAILED

The server answered with an error, or the network request failed. `error.why` has the HTTP status and server message. A network error is in `error.cause`. A read-only room answers `409` with `REALTIME_READ_ONLY`. Read `readOnlyReason` and `saveStatus` for the reason.

## Room errors

### REALTIME_AWARENESS_OWNERSHIP_CONFLICT

A peer sent an awareness update for a client id that another peer owns. The server closes with `4500`.

### REALTIME_AWARENESS_TOO_LARGE

The room's awareness state is over 8 MiB. Keep less data in awareness.

### REALTIME_DOCUMENT_CONFLICT

A document adapter throws `new RealtimeDocumentConflict(why)` when the stored digest differs from `ifDigest`. A Workspace conflict also counts. Realtime re-seeds the room from the stored document and resets clients with `source-changed`. Check for it with `isRealtimeDocumentConflict(error)`.

### REALTIME_DOCUMENT_TOO_LARGE

An update would make the document state larger than 8 MiB. The server closes with `4400`.

### REALTIME_INVALID_AWARENESS

An awareness state is not a plain object.

### REALTIME_TOO_MANY_AWARENESS_CLIENTS

One peer sent more than 1,024 awareness clients.

## Configuration errors

### REALTIME_MISSING_ACCESS

The definition sets no access rule. Without one, each person could read and write each room. Set `auth: true` to require a signed-in user, add `authorize()` to decide each request, or set `access: 'public'` for open rooms.

```diff [server/realtime/docs.ts]
 export default defineRealtime({
+  auth: true,
   document: { workspace: 'docs' },
 })
```

### REALTIME_INVALID_ACCESS

The access rule is not clear. `access` accepts only `'public'`, and you cannot use it with `auth` or `authorize()`. `origins()` with `auth: true` and no `identify()` is also an error, because the ViteHub Auth session is a cookie that only the app's own origin can use.

### REALTIME_CHECKPOINT_UNSUPPORTED

The definition sets `history.checkpoint`, but its document adapter has no `checkpoint()` method. Add `checkpoint()` to the adapter, use `document: { workspace }`, or remove `history`.

### REALTIME_INVALID_PERSISTENCE

`persistence.debounce` or `persistence.maxWait` is not a number of milliseconds of 0 or more, or `maxWait` is less than `debounce`.

### REALTIME_INVALID_USER

The identity's user has no `id`, or the `id` is not a string of at most 256 characters.

### REALTIME_INVALID_POSTGRES_URL

`REALTIME_POSTGRES_URL` is set to something that is not a `postgres://` or `postgresql://` URL. Fix it, or remove it so that Realtime uses the connection of the Default Database.

### REALTIME_MISSING_BUS_CONNECTION

`authority: "redis"` needs `REDIS_URL`. `authority: "postgres"` needs a Default Database with `dialect: "postgresql"`, or `REALTIME_POSTGRES_URL`. Realtime does not read `DATABASE_URL` itself. Add the connection, or use `authority: "auto"`, which keeps rooms in one process without one.

### REALTIME_ROOM_LOCK_TIMEOUT

Saves of one room run one at a time across Node instances. An instance waited 30 seconds for the Redis save lock of a room. Make the document adapter `save()` finish faster. Realtime tries the save again.

### REALTIME_MISSING_DIGEST

A save needs file digests from the Workspace Store, or a checkpoint found no stored document after its save. Use a Workspace Store that returns digests, or return `digest` from the adapter's `save()`.

## Build errors

### REALTIME_AUTHORITY_CONFLICT

`authority: "cloudflare"` needs a Cloudflare host. `authority: "memory"`, `"postgres"`, and `"redis"` need the `node` host.

### REALTIME_MISSING_AUTHORITY

A production build with `authority: "auto"` found neither a Cloudflare nor a Node host. Use the Cloudflare host for Durable Objects, or the Node host to share rooms through Postgres or Redis.
