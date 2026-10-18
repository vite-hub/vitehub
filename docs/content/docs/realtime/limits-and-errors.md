---
title: Realtime limits and errors
description: Handle Realtime request errors by code, read room close codes, and repair Realtime configuration.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle request errors

`save()`, `history.checkpoint()`, and `refresh()` of `useRealtimeTiptap()` return `[error, data]`. When `error` is set, `error.code` names the failure, `error.why` tells what went wrong, `error.fix` tells what to do, and `error.docs` links to the code on this page.

```ts [app/components/PageEditor.vue]
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

The type of `error.code` is `RealtimeRequestErrorCode`: `REALTIME_DISABLED`, `REALTIME_DISCONNECTED`, `REALTIME_INVALID_RESPONSE`, `REALTIME_MISSING_DOCUMENT`, or `REALTIME_REQUEST_FAILED`. The composable retries `409` answers with `REALTIME_SYNC_PENDING` before it returns an error.

Room errors happen after the WebSocket opens, so they go into the stream: the server closes the connection with a close code. Configuration and build errors throw.

| Code | Where |
| --- | --- |
| `REALTIME_DISABLED`, `REALTIME_DISCONNECTED`, `REALTIME_INVALID_RESPONSE`, `REALTIME_MISSING_DOCUMENT`, `REALTIME_REQUEST_FAILED` | Returned by `save()`, `history.checkpoint()`, and `refresh()` |
| `REALTIME_AWARENESS_OWNERSHIP_CONFLICT` | WebSocket close code `4500` |
| `REALTIME_AWARENESS_TOO_LARGE`, `REALTIME_DOCUMENT_TOO_LARGE`, `REALTIME_INVALID_AWARENESS`, `REALTIME_TOO_MANY_AWARENESS_CLIENTS` | WebSocket close code `4400` |
| `REALTIME_DOCUMENT_CONFLICT` | Thrown by a document adapter. The room re-seeds and clients reset. |
| `REALTIME_INVALID_PERSISTENCE`, `REALTIME_INVALID_USER`, `REALTIME_MISSING_DIGEST` | Thrown on the server when a room opens or saves |
| `REALTIME_AUTHORITY_CONFLICT`, `REALTIME_MISSING_AUTHORITY` | Thrown when Vite reads the config |

## Limits

- One WebSocket message is at most 1 MiB.
- Document state and awareness state are each at most 8 MiB per room.
- One peer can own at most 1,024 awareness clients.
- `authority: "memory"` keeps at most 128 active rooms in one process.

## Request errors

### REALTIME_DISABLED

The composable has `enabled: false`, so the request did not run.

### REALTIME_DISCONNECTED

The document changed, the composable was disabled or destroyed, or its scope stopped while the request ran. Call the method again after the new document connects.

### REALTIME_INVALID_RESPONSE

The server answered with a body that the client cannot use. Use the same `@vite-hub/realtime` version on the client and the server.

### REALTIME_MISSING_DOCUMENT

`documentId` of `useRealtimeTiptap()` is empty.

### REALTIME_REQUEST_FAILED

The server answered with an error, or the network request failed. `error.why` has the HTTP status and the server message. A read-only room answers `409` with `REALTIME_READ_ONLY`; read `readOnlyReason` and `saveStatus` for the reason. A network error is in `error.cause`.

## Room errors

### REALTIME_AWARENESS_OWNERSHIP_CONFLICT

A peer sent an awareness update for a client id that another peer owns. The server closes the connection with `4500`.

### REALTIME_AWARENESS_TOO_LARGE

Awareness state of the room is larger than 8 MiB. Keep less data in awareness.

### REALTIME_DOCUMENT_CONFLICT

A document adapter throws `new RealtimeDocumentConflict(why)` when the stored digest does not equal `ifDigest`. A Workspace conflict also counts. Realtime re-seeds the room from the stored document and resets clients with `source-changed`. Use `isRealtimeDocumentConflict(error)` to check for it.

### REALTIME_DOCUMENT_TOO_LARGE

An update would make the document state larger than 8 MiB. The server closes the connection with `4400`.

### REALTIME_INVALID_AWARENESS

An awareness state is not a plain object.

### REALTIME_TOO_MANY_AWARENESS_CLIENTS

One peer sent more than 1,024 awareness clients.

## Configuration errors

### REALTIME_INVALID_PERSISTENCE

`persistence.debounce` or `persistence.maxWait` is not a non-negative number of milliseconds, or `maxWait` is less than `debounce`.

### REALTIME_INVALID_USER

The user of a realtime identity has no `id`, or its `id` is not a string of at most 256 characters.

### REALTIME_MISSING_DIGEST

A save needs file digests from the Workspace Store, or a checkpoint found no stored document after its save. Use a Workspace Store that returns digests, or return `digest` from the adapter `save()`.

## Build errors

### REALTIME_AUTHORITY_CONFLICT

`authority: "cloudflare"` needs a Cloudflare preset. `authority: "memory"` runs in one process, so it needs the `node` preset.

### REALTIME_MISSING_AUTHORITY

A production build with `authority: "auto"` found no Cloudflare preset. Deploy with a Cloudflare preset, or set `authority: "memory"` for one Node.js process.
