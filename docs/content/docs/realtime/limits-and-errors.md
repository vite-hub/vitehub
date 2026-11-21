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

realtime.onReset(({ reason }) => {
  if (reason === 'source-changed')
    toast.add({ title: 'The editor reset because the stored page changed' })
})

async function publish() {
  const [error, checkpoint] = await realtime.history.checkpoint()
  if (error?.code === 'REALTIME_SOURCE_CHANGED') {
    toast.add({ title: 'Not published', description: 'The stored page changed outside this room.' })
    return
  }
  if (error) {
    toast.add({ title: 'Not published', description: error.why })
    return
  }
  toast.add({ title: `Published ${checkpoint.snapshot.id}` })
}
```

`error.code` has the type `RealtimeRequestErrorCode`. Check the code first to read the typed `error.data`. When the server names why it refused the request, such as a stored document that changed outside the room, a read-only room, or edits that still did not reach the room after 20 retries, `error.code` is that name. [Realtime diagnostics](/docs/realtime/diagnostics) explains each code. Other server and network errors are `REALTIME_REQUEST_FAILED`.

Room errors happen after the WebSocket opens, so the server closes the connection with a close code. Configuration and build errors throw.

| Code | Where |
| --- | --- |
| `REALTIME_DISABLED`, `REALTIME_DISCONNECTED`, `REALTIME_INVALID_RESPONSE`, `REALTIME_MISSING_DOCUMENT`, `REALTIME_REQUEST_FAILED`, and the codes that the server names | Returned by `save()`, `history.checkpoint()`, and `refresh()` |
| `REALTIME_AWARENESS_OWNERSHIP_CONFLICT` | WebSocket close code `4500` |
| `REALTIME_AWARENESS_TOO_LARGE`, `REALTIME_DOCUMENT_TOO_LARGE`, `REALTIME_INVALID_AWARENESS`, `REALTIME_TOO_MANY_AWARENESS_CLIENTS` | WebSocket close code `4400` |
| `REALTIME_DOCUMENT_CONFLICT` | Thrown by a document adapter. The room re-seeds and clients reset. |
| `REALTIME_MISSING_ACCESS`, `REALTIME_INVALID_ACCESS`, `REALTIME_CHECKPOINT_UNSUPPORTED` | Thrown by `defineRealtime()` and when the server loads the definition |
| `REALTIME_INVALID_PERSISTENCE`, `REALTIME_INVALID_USER`, `REALTIME_MISSING_DIGEST` | Thrown on the server when a room opens or saves |
| `REALTIME_DRIVER_CONFLICT`, `REALTIME_MISSING_DRIVER` | Thrown when Vite reads the config |

## Limits

- One WebSocket message is at most 1 MiB.
- Document state and awareness state (who is here, and their cursors) are each at most 8 MiB per room.
- One peer can own at most 1,024 awareness clients.
- One process keeps at most 128 active rooms, also when Node instances share rooms.

## See refusals and failures in logs

With the evlog Nitro module, added through `vitehub({ observability })` or by hand, Realtime puts each refused connection and each refused save, checkpoint, or refresh on the request's wide event, in a `realtime` field:

```json
{ "path": "/api/_vitehub/realtime/pages/guides/welcome.md", "status": 403, "realtime": { "definition": "pages", "room": "guides/welcome.md", "refused": "authorize", "status": 403 } }
```

| Field | Meaning |
| --- | --- |
| `definition`, `room` | The Realtime Definition and the room id. The room id of a `document: false` Definition can be a token, such as a page id, so the event has a short hash of it: `#3f2a9c1e`. |
| `refused` | `path`, `definition`, `origin`, `session`, `identify`, `authorize`, or `room` (the room could not open). `error` for other failures. |
| `status` | The HTTP status that the browser got. |
| `code` | The diagnostic code of the cause, such as `AUTH_R0007` when the Auth origin check refused the request. |

When `authorize()`, `identify()`, or the room throws during a connection, the wide event also gets the error, and the server prints it to the console. The fields do not include tokens, cookies, or user data.

Failures after the WebSocket opens have no request. Realtime logs each one as its own evlog event, `{ action: "realtime", message, realtime }`:

| `realtime` field | Event |
| --- | --- |
| `closed` | Once for each connection: the server closed the connection with a close code from the table above, or `4403` for a write without access, or `1013` for updates that come too quickly. Level `warn`. |
| `failed: "peer"` | The connection failed. Level `error`, with the error. |
| `failed: "bus-publish"`, `"bus-receive"`, `"bus-repair"`, `"bus-reset"`, `"bus-lock"` | Node instances could not share a room through Redis or Postgres. Level `error`, except `bus-lock` (`warn`). |
| `failed: "save"`, `"hold"`, `"release"`, `"refresh"` | The document adapter failed in a save, `hold()`, or `release()` that runs on its own, or a refresh failed. Level `warn`. |

Realtime sends these events to evlog when the app installs evlog and registers its Nitro module. They also reach the app's `evlog:drain` hooks. Without evlog, or with evlog's `enabled: false`, Realtime prints the failures of instances and adapters to the console, and does not log closes or connection errors.

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

The server answered with an error that names no Realtime code, or the network request failed. `error.why` has the HTTP status and server message, and `error.data.status` has the HTTP status. A network error has no status, and the error is in `error.cause`.

## Room request errors

`requestRealtimeRoom()` returns them as `[error, undefined]`. It never throws.

### REALTIME_ROOM_ABORTED

The `signal` of the request aborted, such as when the Agent run that asked was cancelled.

### REALTIME_ROOM_CROWDED

More than one browser is in the room. A request goes to one browser, so give each browser its own room, such as a random id for each tab.

### REALTIME_ROOM_ELSEWHERE

With Redis or Postgres, no browser of this instance is in the room. Requests reach only the browsers connected to the same instance.

### REALTIME_ROOM_EMPTY

No browser is in the room after `wait` milliseconds, 5 seconds by default, or the browser left before it answered.

### REALTIME_ROOM_REFUSED

The browser answered with an error: its handler threw, it has no `onRequest()` handler, or its answer is over 1 MiB. `error.why` has its reason.

### REALTIME_ROOM_REQUESTS_OFF

The Realtime Definition does not take requests. Define it with `defineRealtime({ access: "public", document: false, requests: true })`.

### REALTIME_ROOM_TIMEOUT

The browser did not answer in `timeout` milliseconds, 30 seconds by default.

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

The definition sets no access rule. Without one, each person could read and write each room. Set `authorize: true` to require a signed-in user, set `authorize()` to decide each request, or set `access: 'public'` for open rooms.

```diff [server/realtime/docs.ts]
 export default defineRealtime({
+  authorize: true,
   document: { workspace: 'docs' },
 })
```

### REALTIME_INVALID_ACCESS

The access rule is not clear. `access` accepts only `'public'`, and you cannot use it with `authorize`. `authorize` accepts only `true` or a function. `origins()` with `authorize: true` and no `identify()` is also an error. Only the Auth trusted-origin policy can allow a different origin to use the ViteHub Auth session.

A definition that still sets `auth` fails too. Replace `auth: true` with `authorize: true`. Next to an `authorize()` callback, remove `auth`: the callback now also runs for signed-out callers, so return `false` when `user` is `null`. `vitehub migrate` makes the first change and lists the second.

```diff [server/realtime/pages.ts]
 export default defineRealtime({
-  auth: true,
-  authorize: ({ user, mode }) => mode === 'read' || isEditor(user),
+  authorize: ({ user, mode }) => user !== null && (mode === 'read' || isEditor(user)),
   document: pagesDocument,
 })
```

### REALTIME_CHECKPOINT_UNSUPPORTED

The definition sets `history.checkpoint`, but its document adapter has no `checkpoint()` method. Add `checkpoint()` to the adapter, use `document: { workspace }`, or remove `history`.

### REALTIME_INVALID_PERSISTENCE

`persistence.debounce` or `persistence.maxWait` is not a number of milliseconds of 0 or more, or `maxWait` is less than `debounce`.

### REALTIME_INVALID_USER

The identity's user has no `id`, or the `id` is not a string of at most 256 characters.

### REALTIME_INVALID_POSTGRES_URL

`REALTIME_POSTGRES_URL` is set to something that is not a `postgres://` or `postgresql://` URL. Fix it, or remove it so that Realtime uses the connection of the Default Database.

### REALTIME_MISSING_BUS_CONNECTION

`driver: "redis"` needs `REDIS_URL`. `driver: "postgres"` needs a Default Database with `dialect: "postgresql"`, or `REALTIME_POSTGRES_URL`. Realtime does not read `DATABASE_URL` itself. Add the connection, or use `driver: "auto"`, which keeps rooms in one process without one.

### REALTIME_ROOM_LOCK_TIMEOUT

Saves of one room run one at a time across Node instances. An instance waited 30 seconds for the Redis save lock of a room. Make the document adapter `save()` finish faster. Realtime tries the save again.

### REALTIME_MISSING_DIGEST

A save needs file digests from the Workspace Store, or a checkpoint found no stored document after its save. Use a Workspace Store that returns digests, or return `digest` from the adapter's `save()`.

## Build errors

### REALTIME_DRIVER_CONFLICT

`driver: "cloudflare"` needs a Cloudflare host. `driver: "memory"`, `"postgres"`, and `"redis"` need the `node` host.

### REALTIME_MISSING_DRIVER

A production build with `driver: "auto"` found neither a Cloudflare nor a Node host. Use the Cloudflare host for Durable Objects, or the Node host to share rooms through Postgres or Redis.
