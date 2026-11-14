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
| `defineRealtime` from `vite-hub/realtime` | Declare a room file in `server/realtime`. |
| `defineRealtimeEditor`, `realtimeMarkdownEditor` from `vite-hub/realtime` | Declare an editor schema and Markdown codec, or use the built-in kit. |
| `RealtimeDocumentConflict` from `vite-hub/realtime` | Throw from a document adapter when `ifDigest` no longer matches. |
| `realtimeDocumentLayout`, `readRealtimeStatus` from `vite-hub/realtime` | Read a room document's `body`, `fields`, and `status` root types. |
| `useRealtimeTiptap` from `vite-hub/realtime/vue` | Connect a Vue TipTap editor, fields, presence, saves, and resets. |
| `connectRealtimeRoom` from `vite-hub/realtime/client` | Join one room for [presence without an editor](#presence-without-an-editor), in any framework. |
| `refreshRealtimeDocument` from `vite-hub/realtime/server` | Tell a document's open room that its stored copy changed. |
| `requestRealtimeRoom` from `vite-hub/realtime/server` | Ask the one browser in a room and wait for its answer ([Requests to a browser](#requests-to-a-browser)). |
| `isRealtimeAvailable` from `vite-hub/realtime/server` | Check if this build has a room authority ([Builds without Realtime](/docs/realtime/configure#builds-without-realtime)). |
| `workspaceDocument` from `vite-hub/realtime/server` | The Workspace document adapter, to wrap or combine. |
| `blobDocument` from `vite-hub/realtime/server` | A document adapter that stores each document as one private Blob file ([Blob documents](#blob-documents)). |
| `createRealtimeHandler` from `vite-hub/realtime/server` | Build a handler for a manual server setup. ViteHub generates this route for normal apps. |

ViteHub generates `.vitehub/nitro/realtime/registry.mjs` and
`.vitehub/nitro/realtime/handler.ts`. Read them to inspect the build, but do
not import them.

## How a room keeps state

While a room is open, its Yjs state is the source of truth. Realtime loads
the stored document once, when the room opens, and then only saves to it. It
never rebuilds a Yjs document from Markdown for clients that already have
state, because merging two separately built documents duplicates content.

When the stored document changes outside the room, Realtime re-seeds the room
from the new version and resets every client. A reset closes the connection.
The Vue composable drops its Y.Doc, reports the reset, and reconnects with an
empty one.

## Custom document adapters

`document: { workspace: 'docs' }` stores each path as a Markdown file in a
Workspace working tree. To store documents elsewhere, pass an adapter object.
Realtime calls it with plain snapshots. Your storage stays a copy synced from
the room.

This adapter stores pages in the `pages` table of the default Database:

```ts [server/databases/default.ts]
import { defineDatabase } from 'vite-hub/database'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    pages: sqliteTable('pages', {
      id: text('id').primaryKey(),
      title: text('title').notNull(),
      body: text('body').notNull(),
      version: text('version').notNull(),
      editedBy: text('edited_by'),
    }),
  },
})
```

```ts [server/realtime/pages.ts]
import { and, eq } from 'drizzle-orm'
import { useDatabase } from 'vite-hub/database'
import { RealtimeDocumentConflict, defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  document: {
    kind: 'pages',
    async load({ documentId }) {
      const { db, schema } = useDatabase('default')
      const [page] = await db.select().from(schema.pages).where(eq(schema.pages.id, documentId))
      if (!page) return { body: '', digest: null }
      return { body: page.body, digest: page.version, fields: { title: page.title } }
    },
    async save({ documentId }, { body, fields }, { ifDigest, user }) {
      const { db, schema } = useDatabase('default')
      const title = String(fields?.title ?? '')
      const page = { body, title, version: crypto.randomUUID(), editedBy: user?.id ?? null }
      // `ifDigest: null` saves a page that does not exist yet.
      const saved = ifDigest === null
        ? await db.insert(schema.pages).values({ id: documentId, ...page }).onConflictDoNothing().returning()
        : await db.update(schema.pages).set(page).where(and(eq(schema.pages.id, documentId), eq(schema.pages.version, ifDigest))).returning()
      if (!saved.length) throw new RealtimeDocumentConflict()
      return { digest: page.version, issues: title ? [] : [{ field: 'title', message: 'Add a title', path: [] }] }
    },
  },
})
```

| Member | Contract |
| --- | --- |
| `load(context)` | Returns `{ body, fields?, digest }`. `digest: null` means the document does not exist yet. Called when a room opens and on `refresh()`. |
| `save(context, { body, fields }, options)` | Stores the snapshot only if the stored digest equals `options.ifDigest`. Else throws `RealtimeDocumentConflict` (a Workspace conflict also counts). Returns `{ digest, issues?, stored? }`. |
| `stored` | The stored form when the adapter normalized the snapshot. Realtime merges the difference into the room as a structural diff, with no reset, and keeps concurrent edits. Omit `fields` to leave live fields as they are. An interrupted shared save can reset the room; see below. |
| `issues` | Validation problems that did not block the save. They show in the room `status` map. |
| `checkpoint(context, { digest, message, user })` | Optional. Records a history entry that must contain `digest`. Enables `history.checkpoint()`. Without it, `history.checkpoint` fails with `REALTIME_CHECKPOINT_UNSUPPORTED` when the server loads the definition. |
| `hold(context, { users })` | Optional. Called while a writable room has clients: when one joins or leaves, and every 60 seconds. `users` are the identified people connected now. Use it to hold a lease. A thrown error shows in the room `status` until a later call works. |
| `release(context)` | Optional. Called once after the last writer left a room that `hold()` kept, after the room saved. |
| `kind` | Optional label for `vitehub inspect`. |

`context` is `{ authority, definition, documentId }`. `authority` is `memory`,
`cloudflare`, `postgres`, or `redis`, so an adapter can refuse a temporary store
behind a durable or shared room. With `postgres` or `redis`, several instances
call `save()` for one room, one at a time, and `ifDigest` is the digest of the
last save of any instance. `options` is `{ ifDigest, reason, user, editors }`:

- `reason` is `idle`, `leave`, or `request`.
- `user` is the latest identified editor.
- `editors` lists every identified user who changed the room since the last
  save.

Adapters run inside the room authority. On Cloudflare that is the Durable
Object, so bindings come from its environment.

### Interrupted normalizing saves

On Postgres and Redis, the adapter save and the shared room-record write are
separate operations. If the record write fails, the saving instance keeps the
exact stored Yjs state and digest and retries that record before its next save.
It does not use body equality to recognize its own completed save.
An existing room on another instance retries for at least ten seconds before
treating an unmatched pending save as an outside write.

If that instance stops, or another instance recovers the pending record before
the saver retries, only the submitted snapshot and the loaded document remain.
A normalized body or changed fields cannot be distinguished from an outside
write. Realtime then re-seeds with `source-changed`, rather than guessing and
overwriting an outside change. The Vue reset event includes the old Y.Doc as
`previous`; copy its contents in an `onReset` listener to recover edits made
after the interrupted save. The composable destroys that Y.Doc after the
listeners return. A pending save whose submitted body and fields match the
loaded document recovers without a reset.

### Blob documents

`blobDocument(store, { prefix, contentType })` stores each document's body as
one private Blob file at `prefix + documentId`. The digest is the SHA-256 of
the body. `contentType` defaults to `text/markdown; charset=utf-8`. A `%` in
the document id stays a literal `%` in the Blob pathname, so `a%2Fb.md` and
`a/b.md` are two files.

```ts [server/realtime/drafts.ts]
import { blob } from 'vite-hub/blob'
import { defineRealtime } from 'vite-hub/realtime'
import { blobDocument } from 'vite-hub/realtime/server'

export default defineRealtime({
  document: blobDocument(blob, { prefix: 'drafts/' }),
})
```

`save()` reads the stored file first. It throws `RealtimeDocumentConflict`
when the file changed, was created, or was deleted after the room loaded it.

> [!WARNING]
> Blob has no conditional write. An outside write between that read and the
> save's write is lost.

After you change the file outside the room, call `refreshRealtimeDocument()`
so the room loads it.

## Editor codecs

The editor codec owns the schema and the Markdown conversion. The server
builds the ProseMirror schema from `extensions()` and calls the codec. It never
creates an editor view, so a codec must not depend on the DOM. All functions
can be async.

```ts [shared/editor.ts] fragment
import { defineRealtimeEditor } from 'vite-hub/realtime'

export const pagesEditor = defineRealtimeEditor({
  extensions: () => [/* the same TipTap extensions the browser uses */],
  async fromMarkdown(markdown) { return await parseToProseMirrorJSON(markdown) },
  async toMarkdown(document) { return await serializeProseMirrorJSON(document) },
})
```

Use it in the definition with `editor: pagesEditor` and in the browser with
`useRealtimeTiptap('pages', id, { editor: pagesEditor })`. Both sides must
use the same extensions. When documents of one definition use different
schemas, `editor` can be a function of the document context, such as
`({ documentId }) => editorFor(documentId)`. Content uses this for one codec
per collection ([Edit Content together](/docs/content/editing-together#live-editing)).
Without `editor`, Realtime uses `realtimeMarkdownEditor`: StarterKit, images,
tables, and raw YAML frontmatter as an atom node, parsed by `@tiptap/markdown`.

A lossless codec gives `toMarkdown(fromMarkdown(x)) === x` for your users'
documents. Realtime converts only at seed and save time, so a lossy codec
changes stored formatting on the first save, not on every keystroke.

### Change the schema safely

TipTap deletes the nodes that its schema does not know from the shared Yjs
document, for every client and the server. Give the codec a `version`, and
change it when a new `extensions()` or codec cannot read the Yjs state of the
previous one, such as when you remove or rename a node type:

```ts [shared/editor.ts] fragment
export const pagesEditor = defineRealtimeEditor({
  version: '2',
  extensions: () => [/* ... */],
  fromMarkdown,
  toMarkdown,
})
```

- A Durable Object room restores its Yjs state only when the stored digest and
  the version both match. Otherwise it seeds from the stored Markdown with a
  new epoch, as after an outside write. Unsaved Yjs edits of the old version
  are lost, so the first version you set also re-seeds each persisted room once.
- `useRealtimeTiptap('pages', id, { editor: pagesEditor })` sends the version
  with the connection. A connection with another version, or without one, is
  read-only with `readOnlyReason` `version`. The server drops its document
  updates and keeps it open for live updates. Ask the user to reload to edit.

### Guard documents the codec cannot keep

Most codecs normalize some Markdown and lose some. For example, a codec can
drop an undeclared `::callout` wrapper or unwrap raw HTML. A room saves on its
own, so the first save after any edit rewrites the stored document. Add
`verify()` to tell Realtime what the codec does with a stored document:

```ts [shared/editor.ts] fragment
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
| `writable: false` | The whole room opens read-only, body and fields. `status.error` explains why, and `status.issues` holds the `issues`. The room never saves. `save()` and `history.checkpoint()` answer `409` with `REALTIME_READ_ONLY`. A client update closes the connection with `4403`. |
| `canonical` | The body the codec writes for the unchanged document. A save with this body and unchanged fields writes nothing, so editing back to the start does not rewrite `* item` as `- item`. |
| `issues` | Shown in `status.issues` until the first save. |

Realtime calls `verify(body, { fields })` each time it seeds a room from the
stored document: when the room opens and after a re-seed. After you fix the
stored document, `refresh()` re-seeds the room, so it can become writable.

Realtime also guards every save, with or without `verify()`:

- It builds the ProseMirror document from the room with the schema of
  `extensions()` and checks it. If the room holds a node or content that the
  schema does not allow, it does not save. The room stays dirty, `status.error`
  explains why, and `save()` answers `422` with `REALTIME_INVALID_DOCUMENT`.
- It parses the Markdown it is about to save. If `fromMarkdown(toMarkdown(doc))`
  differs from the room body, it saves anyway and adds an entry to
  `status.issues`.
- If the stored body ends with a newline and the codec output does not,
  Realtime adds it back.

## Structured documents

Every room document has three root types, named in `realtimeDocumentLayout`:

| Root | Type | Written by |
| --- | --- | --- |
| `body` | `Y.XmlFragment` | Clients, through TipTap Collaboration. |
| `fields` | `Y.Map` with one JSON value per field | Clients. For two writes to the same field at once, the last write wins. Different fields never conflict. |
| `status` | `Y.Map`: `digest`, `error`, `issues`, `savedAt`, `savedBy` | The server only. `error` also holds the read-only reason from `verify()`. |

```ts
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

const realtime = useRealtimeTiptap('pages', 'about')

realtime.fields.value?.set('title', 'About us')
realtime.saveStatus.value // { digest, error, issues, savedAt, savedBy }
realtime.readOnly.value // true when the server rejects edits from this connection
realtime.readOnlyReason.value // 'access', 'document', 'version', or null
```

`readOnlyReason` is `access` when `authorize` denied write, `document`
when `verify()` returned `writable: false`, and `version` when the browser runs
another editor `version` than the server. Pass `editable: !readOnly` to the
editor, show `saveStatus.error` for the `document` reason, and ask the user to
reload for the `version` reason.

`status` lives in the Yjs document, so it arrives in order with its content,
survives a Durable Object restart, and plain Yjs can read it.
The server checks each client update against a copy of the room, and closes
the connection with `4403` when an update changes `status`. Write whole values
to a field. Nested objects in a field are replaced, not merged.

## Identity and authorization

```ts [server/realtime/pages.ts] fragment
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
| `identify({ request, event, definition })` | Finds the user for each WebSocket and HTTP request. Return `null` for anonymous. Replaces the ViteHub Auth session. Requests with an `Origin` other than the app origin get 403, unless `origins` accepts it. Behind a TLS-terminating proxy, the app origin uses the first `X-Forwarded-Proto` and `X-Forwarded-Host` values. |
| `origins({ origin, request, event, definition })` | Lets a page on another origin connect to a definition with `identify`, such as a script that sites load from your app. Return `true` to accept `origin`. A cross-site handshake carries cookies too, so `identify` must then trust only what the page sends, such as a ticket in `params`. See [From another site](#from-another-site). |
| `auth: true` | Requires an identified user (else 401). Without `identify`, the user is the ViteHub Auth session, and the Auth trusted-origin policy applies. |
| `authorize({ request, event, user, documentId, mode })` | Called with `mode: 'read'` on every request, and `mode: 'write'` on connections, saves, and checkpoints. Return `false` to deny. A connection denied write is read-only: the server closes it with `4403` if it sends a change. `documentId` is `null` for the Workspace event channel. |

`event` is the request event of the WebSocket upgrade or HTTP request, a `RealtimeRequestEvent`. Read the request and its cookies from `event['~standard'].req`, the platform bindings from `event['~standard'].runtime`, and the H3 event context from `event.context`. See [Standard Context](/docs/reference/runtime-context#standard-context).

An identified user replaces the client's `user` presence field, so nobody can
fake names and avatars. Without an identity, the client sets its own presence.

In the browser, pass `identity` to `useRealtimeTiptap` when presence comes
from a session other than ViteHub Auth. Server identity still wins.

## Carets

`realtime.extensions` includes other people's carets and selections, in each
person's presence color. They use TipTap's CollaborationCaret classes:
`collaboration-carets__caret`, `collaboration-carets__label`, and
`ProseMirror-yjs-selection`. TipTap ships no styles for them. `@vite-hub/ui`
styles them in `styles.css`.

Do not add `@tiptap/extension-collaboration-caret` next to Realtime. It has its
own copy of y-tiptap, so it cannot find Realtime's sync plugin and draws
nothing. To change the markup, pass `render` and `selectionRender` in `carets`,
with the same arguments as in TipTap's CollaborationCaret. `render` builds the
caret element. `selectionRender` returns a selection's decoration attributes.
Options you leave out keep the default.

```ts fragment
const realtime = useRealtimeTiptap('docs', 'guides/welcome.md', {
  carets: {
    render: (user) => {
      const caret = document.createElement('span')
      caret.className = 'caret'
      caret.style.borderColor = user.color
      caret.title = user.name
      return caret
    },
  },
})
const editor = useEditor({ extensions: realtime.extensions.value })
```

`realtime.extensions` binds the carets to the current document. It is empty
during SSR and while the document id is empty. It changes with the document,
so create the editor again for each document. Pass `carets: false` to leave
carets out.

## Presence without an editor

`connectRealtimeRoom(definition, documentId, options?)` joins one room to share presence, such as who is on a page and where each cursor is. It does not edit the room document and needs no Vue. [Comments](/docs/comments/server-api#presence-rooms) uses it for its page rooms.

When the rooms of a definition only share presence, set `document: false`. Nothing loads or saves, and `authorize()` is asked only for `read`:

```ts [server/realtime/presence.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({
  auth: true,
  document: false,
})
```

A client that sends a document update to such a room is disconnected. `save()`, `refresh()`, and `history.checkpoint()` requests get HTTP 404, and `refreshRealtimeDocument()` returns `false`. `editor`, `history`, and `persistence` are type errors with `document: false`.

```ts fragment
import { connectRealtimeRoom } from 'vite-hub/realtime/client'
import { commentRoom, normalizeCommentPage } from 'vite-hub/comments'

const page = normalizeCommentPage(location.pathname)
const room = connectRealtimeRoom('comments', commentRoom(page), { changes: true, params: { page } })
room.setLocal('cursor', { x: 120, y: 80 })
room.onUpdate(() => render(room.people(), room.states()))
room.onChange(change => reload(change))
```

| Member | Behavior |
| --- | --- |
| `people()` | The people in the room, this browser included. |
| `states()` | The fields that each other client set with `setLocal()`, by client id. |
| `setLocal(field, value)` | Sets one field of this browser's awareness state. `null` removes it. |
| `status()` | `connecting`, `connected`, or `disconnected`. |
| `notify(change)`, `onChange(listener)` | Send and receive change hints through the workspace events room. Both need `changes: true`. |
| `onUpdate(listener)` | Runs when people, their fields, or the status change. Returns a function that removes it. |
| `destroy()` | Leaves the room. |

`identity` sets who this browser shows as. A definition with `identify` or `auth: true` replaces it with the server's identity. When the room re-seeds, the client joins the new seed on its own.

`params` sends query parameters on presence and workspace connections, so a definition can check context such as the current page.

> [!WARNING]
> The definition must check that context against the requested document before it grants access.

### Requests to a browser

Server code can ask the one browser in a room of a presence definition, and wait for its answer. The [page bridge](/docs/agents/capabilities/page) uses it so that an Agent works the person's page. Set `requests: true` on the definition:

```ts [server/realtime/tabs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({ document: false, requests: true })
```

The browser answers with `onRequest()`. The value it returns goes back as JSON:

```ts fragment
import { connectRealtimeRoom } from 'vite-hub/realtime/client'

const tab = crypto.randomUUID()
const room = connectRealtimeRoom('tabs', tab)
room.onRequest(body => ({ title: document.title, asked: body }))
```

Server code asks it with `requestRealtimeRoom(definition, room, body, options?)`:

```ts fragment
import { requestRealtimeRoom } from 'vite-hub/realtime/server'

const [error, answer] = await requestRealtimeRoom('tabs', tab, { want: 'title' })
if (error) console.warn(error.code, error.why)
```

- One browser answers. A room with two browsers returns `REALTIME_ROOM_CROWDED`, so give each tab its own random room id.
- A room without a browser waits `wait` milliseconds, 5 seconds by default, for one to join, such as after a reload. Then it returns `REALTIME_ROOM_EMPTY`.
- The browser has `timeout` milliseconds to answer, 30 seconds by default. `signal` stops the request.
- An answer only counts from the browser that was asked. A browser that leaves fails its requests at once.
- On Cloudflare the request goes to the Durable Object that holds the rooms. On Node it reaches the rooms of this process. With Redis or Postgres, a browser on another instance gives `REALTIME_ROOM_ELSEWHERE`.
- The room id is the only key. Anyone who knows it can join the room of a public definition, so use a random id and keep it out of URLs and logs, or keep a room per person with `scope: "user"`.

#### A room per person

`scope: "user"` keys each room by the person who joins it, so the same room id for two people is two rooms:

```ts [server/realtime/tabs.ts]
import { defineRealtime } from 'vite-hub/realtime'

export default defineRealtime({ document: false, requests: true, scope: 'user' })
```

The person is the signed-in [Auth](/docs/auth) user of the tab. The definition reads the session when the app has Auth and does not require one: everyone without a session shares one anonymous scope. With `identify` or `auth: true`, those decide who the person is. Server code then names the person, and asks only their room:

```ts fragment
const [error, answer] = await requestRealtimeRoom('tabs', tab, { want: 'title' }, { user: session.user.id })
```

`user: null` asks the anonymous room. A request without `user` returns `REALTIME_ROOM_REFUSED`. A tab joins with the identity it has when it connects, so a tab that signs in reaches its new scope after it reconnects. The [page bridge](/docs/agents/capabilities/page) keeps its rooms this way.

[Room request errors](/docs/realtime/limits-and-errors#room-request-errors) lists every code.

### From another site

A script that other sites load from your app, such as a review toolbar, joins rooms on your app with `origin`. Its definition lets those pages in with `origins` and identifies people by a ticket the script got from your app, never by cookies:

```ts fragment
// On the other site's page
const room = connectRealtimeRoom('presence', roomId, { origin: 'https://app.example.com', params: { ticket } })
```

```ts fragment
// server/realtime/presence.ts
export default defineRealtime({
  origins: ({ origin }) => allowedSites.has(origin),
  identify: ({ request }) => readTicket(new URL(request.url).searchParams.get('ticket')),
  authorize: ({ user }) => Boolean(user),
  document: false,
})
```

The app's own pages connect as before. `origins` is only asked about other origins, and only for definitions with `identify`.

## Saves, refresh, and resets

| Client call | Endpoint | Result |
| --- | --- | --- |
| Idle save | none | 2 s after the last edit, at most 10 s, and when the last client leaves ([Configure](/docs/realtime/configure#control-saves)). |
| `realtime.save()` | `POST …?document=save` | Saves now, including every edit this client sent. Returns `[error, saved]`, where `saved` is `{ digest, document, issues, savedAt, savedBy, error }`. |
| `realtime.refresh()` | `POST …?document=refresh` | Reloads the stored digest. If it changed, re-seeds the room and resets clients. Returns `[error, { digest, reseeded }]`. |
| `realtime.history.checkpoint()` | `POST …?history=checkpoint` | Saves, then records a history entry through the adapter, in one room operation. Returns `[error, checkpoint]`: the save plus `snapshot`. |

Each call returns `[error, data]` and does not throw. `error.code` is a `RealtimeRequestErrorCode` ([Realtime limits and errors](/docs/realtime/limits-and-errors)).

```ts fragment
const [error, saved] = await realtime.save()
if (error) console.warn(error.code, error.why)
else console.log(saved.digest)
```

Save and checkpoint requests send the client's Yjs state. The server answers
`409` with `REALTIME_SYNC_PENDING` until it has that state, and the composable
retries. If a save or checkpoint finds the stored document changed, it
re-seeds the room and answers `409` with `REALTIME_SOURCE_CHANGED`.

When server code changes a stored document, for example in a route that an
Agent calls, call `refreshRealtimeDocument(definition, documentId)` after the
write. The open room re-seeds and resets its clients at once, so people see
the change without a browser `refresh()`:

```ts [server/api/pages/[id].put.ts] fragment
import { refreshRealtimeDocument } from 'vite-hub/realtime/server'

await db.pages.update(id, { body })
await refreshRealtimeDocument('pages', id)
```

It resolves `true` when a room re-seeded, and never throws. A room with
unsaved edits finds the change at its next save. A room that is not open loads
the new copy when it opens. On Cloudflare it reaches rooms through the Worker's
`$DurableObject` binding. Pass `{ durableObjects }` only to use another one.
Content calls it after every save from outside a live room.

Listen for resets to tell people what happened and recover unsaved text:

```ts fragment
realtime.onReset(({ reason, previous }) => {
  // reason: 'source-changed' (someone saved outside the room) or 'stale' (the room was re-seeded while offline)
  // previous: the Y.Doc this client held, destroyed after listeners return
})
```

After a reset, `realtime.document` and `realtime.extensions` point to a new
document. Create the editor again when `document` changes, as for a document
switch.

## Workspace documents and history

With `document: { workspace }`, saves write the Markdown file to the Workspace
working tree with `ifDigest`, and keep its media type and metadata. Workspace
hooks can normalize the file. Realtime merges the stored form back into the
room. Saves need a Workspace Store with conditional writes. A Cloudflare room
also needs a durable Workspace Store.

`history.checkpoint()` commits the working tree to Workspace history. The
commit includes every staged path, also other documents saved by their rooms.
If Workspace history moved, Realtime rebases onto the remote head and retries.
A path changed both locally and remotely takes the remote version and re-seeds
the room.

Turning the composable off destroys its document provider, disconnects
Workspace events, clears queued notifications, and makes requests return
`REALTIME_DISABLED`. Turning it on reconnects both providers for the current
document.
