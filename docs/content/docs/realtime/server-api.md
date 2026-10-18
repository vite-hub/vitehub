---
title: Realtime server API
description: Document adapters, editor codecs, structured documents, identity, authorization, saves, and checkpoints.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports and generated output

| Import | Use |
| --- | --- |
| `defineRealtime` from `vite-hub/realtime` | Declare a discovered Realtime Definition. |
| `defineRealtimeEditor`, `realtimeMarkdownEditor` from `vite-hub/realtime` | Declare an editor schema and Markdown codec, or reuse the built-in kit. |
| `RealtimeDocumentConflict` from `vite-hub/realtime` | Throw from a document adapter when `ifDigest` no longer matches. |
| `realtimeDocumentLayout`, `readRealtimeStatus` from `vite-hub/realtime` | Read the `body`, `fields`, and `status` root types of a room document. |
| `useRealtimeTiptap` from `vite-hub/realtime/vue` | Connect a Vue TipTap editor, fields, presence, saves, and resets. |
| `workspaceDocument` from `vite-hub/realtime/server` | The Workspace document adapter, for wrapping or composing. |
| `createRealtimeHandler` from `vite-hub/realtime/server` | Build a handler for a manual server integration. The ViteHub integration generates this route for normal applications. |

The integration generates `.vitehub/nitro/realtime/registry.mjs` and
`.vitehub/nitro/realtime/handler.ts`. Treat both as inspectable build output,
not application imports.

## How a room keeps state

The room's Yjs state is the source of truth while the room is open. Realtime
loads the stored document once, when the room opens, and then only saves to it.
It never rebuilds a Yjs document from Markdown for clients that already hold
state: merging two independently built documents duplicates their content.

When the stored document changes outside the room, Realtime re-seeds the room
from the new version and resets every client. A reset closes the connection;
the Vue composable drops its Y.Doc, reports the reset, and reconnects with an
empty one.

## Custom document adapters

`document: { workspace: 'docs' }` stores each path as a Markdown file in a
Workspace working tree. Pass an adapter object to store documents anywhere
else. Realtime calls it with plain snapshots; your storage stays a copy synced
from the room.

```ts [server/realtime/pages.ts]
import { RealtimeDocumentConflict, defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: {
    kind: 'pages',
    async load({ documentId }) {
      const page = await db.pages.find(documentId)
      if (!page) return { body: '', digest: null }
      return { body: page.body, digest: page.version, fields: { title: page.title } }
    },
    async save({ documentId }, { body, fields }, { ifDigest, user }) {
      const version = await db.pages.update(documentId, { body, title: fields.title, editedBy: user?.id }, { ifVersion: ifDigest })
      if (!version) throw new RealtimeDocumentConflict()
      return { digest: version, issues: fields.title ? [] : [{ field: 'title', message: 'Add a title', path: [] }] }
    },
  },
})
```

| Member | Contract |
| --- | --- |
| `load(context)` | Returns `{ body, fields?, digest }`. `digest: null` means the document does not exist yet. Called when a room opens and on `refresh()`. |
| `save(context, { body, fields }, options)` | Stores the snapshot only if the stored digest equals `options.ifDigest`; otherwise throws `RealtimeDocumentConflict` (a Workspace conflict also counts). Returns `{ digest, issues?, stored? }`. |
| `stored` | The stored form when the adapter normalized the snapshot. Realtime merges the difference into the room as a structural diff, keeping concurrent edits and without a reset. Omit `fields` to leave live fields untouched. |
| `issues` | Validation problems that did not block the save. They appear in the room `status` map. |
| `checkpoint(context, { digest, message, user })` | Optional. Records a history entry that must contain `digest`. Enables `history.checkpoint()`. |
| `kind` | Optional label for `vitehub inspect`. |

`context` is `{ authority, definition, documentId }`. `authority` is `memory`
or `cloudflare`, so an adapter can refuse an ephemeral store behind a durable
room. `options` is `{ ifDigest, reason, user, editors }`: `reason` is `idle`,
`leave`, or `request`; `user` is the latest identified editor; `editors` lists
every identified user who changed the room since the previous save.

Adapters run inside the room authority. On Cloudflare that is the Durable
Object, so bindings come from its environment.

## Editor codecs

The editor codec owns the schema and the Markdown conversion. The server
builds the ProseMirror schema from `extensions()` and calls the codec; it never
creates an editor view, so a codec must not depend on the DOM. All functions
may be async.

```ts [shared/editor.ts]
import { defineRealtimeEditor } from 'vite-hub/realtime'

export const pagesEditor = defineRealtimeEditor({
  extensions: () => [/* the same TipTap extensions the browser uses */],
  async fromMarkdown(markdown) { return await parseToProseMirrorJSON(markdown) },
  async toMarkdown(document) { return await serializeProseMirrorJSON(document) },
})
```

Use it in the definition with `editor: pagesEditor` and in the browser with
`useRealtimeTiptap('pages', id, { editor: pagesEditor })`. Both sides must
use the same extensions. Without `editor`, Realtime uses `realtimeMarkdownEditor`:
StarterKit, images, tables, and raw YAML frontmatter as an atom node, parsed
by `@tiptap/markdown`.

A lossless codec makes `toMarkdown(fromMarkdown(x)) === x` for documents your
users write. Realtime only converts at seed and save time, so a lossy codec
changes stored formatting on the first save, not on every keystroke.

### Guard documents the codec cannot keep

Most codecs normalize some Markdown and lose some. For example, a codec can
drop an undeclared `::callout` wrapper or unwrap raw HTML. A room autosaves,
so the first save after any edit would rewrite the stored document. Add
`verify()` to tell Realtime what the codec does with a stored document:

```ts [shared/editor.ts]
export const pagesEditor = defineRealtimeEditor({
  extensions: () => [/* ... */],
  fromMarkdown,
  toMarkdown,
  async verify(markdown, { fields }) {
    const lost = await findUnsupportedConstructs(markdown)
    if (lost.length) return { writable: false, issues: lost.map(name => ({ message: `Unsupported: ${name}` })) }
    return { writable: true, canonical: await toMarkdown(await fromMarkdown(markdown)) }
  },
})
```

| Result | Effect |
| --- | --- |
| `writable: false` | The whole room opens read-only, body and fields. `status.error` explains it and `status.issues` holds the `issues`. The room never saves; `save()` and `history.checkpoint()` answer `409` with `REALTIME_READ_ONLY`; a client update closes the connection with `4403`. |
| `canonical` | The body the codec writes for the unchanged document. A save whose body equals it, with unchanged fields, writes nothing, so opening and editing back to the start does not rewrite `* item` as `- item`. |
| `issues` | Shown in `status.issues` until the first save. |

Realtime calls `verify(body, { fields })` each time it seeds a room from the
stored document: when the room opens and after a re-seed. `refresh()` after a
fix to the stored document re-seeds the room, so it can become writable.

Realtime also guards every save, with or without `verify()`:

- It parses the Markdown it is about to save. When `fromMarkdown(toMarkdown(doc))`
  differs from the room body, it saves anyway and adds an entry to
  `status.issues`.
- When the stored body ends with a newline and the codec output does not,
  Realtime adds the newline back.

## Structured documents

Every room document has three root types, named in `realtimeDocumentLayout`:

| Root | Type | Written by |
| --- | --- | --- |
| `body` | `Y.XmlFragment` | Clients, through TipTap Collaboration. |
| `fields` | `Y.Map` with one JSON value per field | Clients. Concurrent writes to the same field resolve last-write-wins; different fields never conflict. |
| `status` | `Y.Map`: `digest`, `error`, `issues`, `savedAt`, `savedBy` | The server only. `error` also holds the read-only reason from `verify()`. |

```ts
const realtime = useRealtimeTiptap('pages', 'about')

realtime.fields.value?.set('title', 'About us')
realtime.saveStatus.value // { digest, error, issues, savedAt, savedBy }
realtime.readOnly.value // true when the server rejects edits from this connection
realtime.readOnlyReason.value // 'access', 'document', or null
```

`readOnlyReason` is `access` when `authorize` denied write, and `document`
when `verify()` returned `writable: false`. Pass `editable: !readOnly` to the
editor and show `saveStatus.error` for the `document` reason.

`status` lives in the Yjs document so it arrives in order with the content it
describes, survives a Durable Object restart, and is readable with plain Yjs.
The server checks every client update against a copy of the room and closes
the connection with code `4403` when an update changes `status`. Write whole
values to a field; nested objects inside a field are replaced, not merged.

## Identity and authorization

```ts [server/realtime/pages.ts]
export default defineRealtime({
  auth: true,
  identify: async ({ event }) => {
    const session = await getConsoleSession(event)
    return session && { id: session.user.id, name: session.user.name, image: session.user.image }
  },
  authorize: ({ user, documentId, mode }) => mode === 'read' || canEdit(user, documentId),
  document: pagesDocument,
})
```

| Option | Behaviour |
| --- | --- |
| `identify({ request, event, definition })` | Resolves the user for each WebSocket and HTTP request. Return `null` for anonymous. Replaces the ViteHub Auth session. Requests whose `Origin` differs from the application origin are rejected with 403. |
| `auth: true` | Requires an identified user (401 otherwise). Without `identify`, the user is the ViteHub Auth session, and the Auth trusted-origin policy applies. |
| `authorize({ request, event, user, documentId, mode })` | Called with `mode: 'read'` on every request and `mode: 'write'` on connections, saves, and checkpoints. Return `false` to deny. A connection denied write is read-only: the server closes it with `4403` if it sends a change. `documentId` is `null` for the Workspace event channel. |

An identified user replaces the client's `user` presence field, so names and
avatars cannot be forged. Without an identity, presence is client-asserted.

In the browser, pass `identity` to `useRealtimeTiptap` when presence should
come from another session than ViteHub Auth. Server identity still wins.

## Carets

`realtime.extensions` includes other people's carets and selections, drawn in
each person's presence color. They render with TipTap's CollaborationCaret
classes: `collaboration-carets__caret`, `collaboration-carets__label`, and
`ProseMirror-yjs-selection`. TipTap ships no styles for them, and
`@vite-hub/ui` styles them in `styles.css`.

Do not add `@tiptap/extension-collaboration-caret` next to Realtime. It has its
own copy of y-tiptap, so it cannot find the sync plugin that Realtime installs,
and it draws nothing. To change the markup, configure `RealtimeCaret` from
`vite-hub/realtime/vue` with `render` and `selectionRender`, and pass
`carets: false` so the default is not added twice.

```ts
const realtime = useRealtimeTiptap('docs', 'guides/welcome.md', { carets: false })
const editor = useEditor({
  extensions: [
    ...realtime.extensions.value,
    RealtimeCaret.configure({ awareness: realtime.provider.value!.awareness, render: renderCaret }),
  ],
})
```

## Saves, refresh, and resets

| Client call | Endpoint | Result |
| --- | --- | --- |
| Idle save | none | 2 s after the last edit, at most 10 s, and when the last client leaves. See [Configure](/docs/realtime/configure#control-saves). |
| `realtime.save()` | `POST …?document=save` | Saves now, including every edit this client sent. Returns `[error, saved]`, where `saved` is `{ digest, document, issues, savedAt, savedBy, error }`. |
| `realtime.refresh()` | `POST …?document=refresh` | Reloads the stored digest. If it changed, re-seeds the room and resets clients. Returns `[error, { digest, reseeded }]`. |
| `realtime.history.checkpoint()` | `POST …?history=checkpoint` | Saves, then records a history entry through the adapter, in one room operation. Returns `[error, checkpoint]`, where `checkpoint` is the save plus `snapshot`. |

Each call returns `[error, data]` and does not throw. `error.code` is a `RealtimeRequestErrorCode`; see [Realtime limits and errors](/docs/realtime/limits-and-errors).

```ts
const [error, saved] = await realtime.save()
if (error) console.warn(error.code, error.why)
else console.log(saved.digest)
```

Save and checkpoint requests send the client's Yjs state. The server answers
`409` with `REALTIME_SYNC_PENDING` until it has received that state; the
composable retries. A save or checkpoint that finds the stored document
changed answers `409` with `REALTIME_SOURCE_CHANGED` after re-seeding the room.

Listen for resets to tell people what happened and to recover text that the
room never saved:

```ts
realtime.onReset(({ reason, previous }) => {
  // reason: 'source-changed' (someone saved outside the room) or 'stale' (the room was re-seeded while offline)
  // previous: the Y.Doc this client held, destroyed after listeners return
})
```

After a reset `realtime.document` and `realtime.extensions` point to a new
document. Recreate the editor when `document` changes, as for a document
switch.

## Workspace documents and history

With `document: { workspace }`, saves write the Markdown file to the Workspace
working tree with `ifDigest`, keeping its media type and metadata. Workspace
hooks may normalize the file; Realtime merges the stored form back into the
room. Saves require a Workspace Store with conditional writes. A Cloudflare
room also requires a durable Workspace Store.

`history.checkpoint()` commits the working tree to Workspace history. The
commit includes every staged path, including other documents saved by their
rooms. If Workspace history moved, Realtime rebases onto the remote head and
retries; a path changed both locally and remotely takes the remote version and
re-seeds the room.

Disabling the composable destroys its document provider, disconnects Workspace
events, clears queued notifications, and makes requests return
`REALTIME_DISABLED`. Enabling it reconnects both providers for the current
document.
