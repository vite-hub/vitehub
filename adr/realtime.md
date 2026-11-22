# @vite-hub/realtime decisions

Each entry records a decision that the code cannot show. See [README.md](README.md) for the format.

## Realtime access fails closed

`assertRealtimeAccess`, `hubRealtime`, `Origin check`, `authorize`, `RealtimeDefinition.origins` in `packages/realtime/src/definition.ts`, `packages/realtime/src/internal/server.ts`, `packages/realtime/src/types.ts`, `packages/realtime/src/vite.ts`.

**Context:** Old keys (`auth`, `authority`) changed meaning. Browsers send cookies and Origin on cross-site WebSocket handshakes; a page cannot set X-Forwarded-* on a handshake.

**Decision:** Renamed keys throw instead of being ignored. The server rejects a foreign Origin unless `origins` accepts it; with `origins`, `identify`/`authorize` must trust only what the page sends, and `authorize: true` without `identify` is rejected. Only `true` from `authorize()` allows.

**Consequences:** Ignoring an old key or treating `undefined` as allow would open rooms to signed-out or cross-site callers.

## On Cloudflare the Durable Object owns rooms and sockets

`refreshDurableRoom`, `requestRoom`, `createRealtimeHandler upgrade` in `packages/realtime/src/internal/server.ts`.

**Context:** Workerd may run the Durable Object in the Worker's isolate, so rooms are visible there, but sockets belong to the Durable Object's requests. After hibernation crossws restores each peer with a bare GET of its first URL.

**Decision:** Refresh and room requests always go to the Durable Object with an internal header the Worker strips from client requests. Room request answers match by peer id so they settle after hibernation; a header-less restore gets only the request hooks.

**Consequences:** Refreshing from the Worker would never reach the sockets, and matching by room object would break after hibernation.

## Rejected WebSocket upgrades carry refusing crossws hooks

`rejectedUpgrade` in `packages/realtime/src/internal/server.ts`.

**Context:** crossws and Nitro's adapters upgrade a request whose handler has no hooks into a socket that never answers.

**Decision:** A rejected upgrade is a Response with its status plus crossws hooks (in the places h3's defineWebSocketHandler uses) whose `upgrade` refuses.

**Consequences:** Returning a bare Response leaves silent sockets.

## Shared Realtime rooms keep one record and save under the room lock

`openSharedDocument`, `saveRoom`, `recoverPendingSave`, `followRoom`, `refreshRoom` in `packages/realtime/src/internal/server.ts`.

**Context:** Several instances can hold one room. Yjs updates from another history duplicate content, and a process can stop between `adapter.save()` and the record write.

**Decision:** Instances agree on one record (epoch, digest, Yjs state). Saves run one at a time under the room lock, take in other instances' saves first, record the submitted state before saving, and never replace a newer pending save. A room at an older epoch follows the new one even after a concurrent edit. Refresh holds the lock for its whole run. An outside change of the stored document wins; clients reset and get the unsaved document as `previous`. Clients with state from an older seed are refused, not merged.

**Consequences:** Moving any step outside the lock or merging across epochs can lose saves or duplicate documents.

## Realtime editor version mismatch makes the connection read-only

`openDocumentRoom`, `connection readOnly`, `createRealtimeEditorExtensions` in `packages/realtime/src/editor.ts`, `packages/realtime/src/internal/server.ts`.

**Context:** TipTap deletes nodes its schema does not know as soon as it renders, and each collaborator's trailing node appends an empty paragraph to the shared document.

**Decision:** A room seeds from Markdown when the persisted Yjs state has another editor version. A browser on another version may read but not write; its schema deletes are dropped without closing, to avoid a reconnect loop. Collaborative editors turn off `trailingNode`.

**Consequences:** Allowing writes across versions deletes content from the shared document.

## Awareness: each connection writes only its own clients

`filterAwarenessEcho`, `AwarenessOwners`, `connectRealtimeRoom`, `useRealtimeTiptap` in `packages/realtime/src/awareness.ts`, `packages/realtime/src/client.ts`, `packages/realtime/src/vue.ts`.

**Context:** Stock y-websocket clients send every awareness change they see, others' too; neither a newer clock nor a null state proves ownership.

**Decision:** The server drops echoes of clients another peer owns and closes a connection that changes them otherwise. ViteHub clients send only their own awareness.

**Consequences:** Trusting clocks for ownership lets one tab erase another's presence.

## Yjs packages load as one module graph

`hubRealtime nitro inline` in `packages/realtime/src/vite.ts`.

**Context:** Two Yjs copies break Yjs constructor checks and drop every client edit. In dev, Vite inlines `yjs` for Realtime when the app cannot resolve it, while other Yjs packages load it natively.

**Decision:** The Nitro environment inlines the whole Yjs family together.

**Consequences:** Inlining only some of them reintroduces the dual-package break.

## The Realtime bus is lossy and rooms reconcile

`createPostgresBus`, `createRedisBus`, `requestSync` in `packages/realtime/src/bus.ts`, `packages/realtime/src/internal/server.ts`.

**Context:** Redis pub/sub loses messages while disconnected and can lose single messages. A room save may use the app's Database pool, including max=1.

**Decision:** Rooms ask other instances for what they lack after a reconnect, after a reset, and periodically. Room locks use a separate postgres.js pool with the same resolved options, and the transaction result is wrapped in an object so postgres.js cannot unwrap an array result.

**Consequences:** Sharing the pool can deadlock a save; assuming reliable delivery loses the last edit.

## Idle rooms leave memory only when their edits are safe

`releaseRoom` in `packages/realtime/src/internal/server.ts`.

**Context:** A memory-only room has no durable copy of unsaved edits.

**Decision:** Presence rooms are destroyed, clean shared rooms reopen from the record, and dirty memory-only rooms stay resident.

**Consequences:** Evicting a dirty memory room loses edits.

## Blob document ids map to one file each, and ETag is read before the body

`blobDocument` in `packages/realtime/src/blob-document.ts`.

**Context:** Blob decodes a pathname once, so `a%2Fb.md` would open `a/b.md`.

**Decision:** Document ids escape `%`. A load reads the ETag before the body, so a write in between makes the conditional put fail.

**Consequences:** Reading the body first could save over a newer file.

## Cloudflare SqlStorage is accepted only with workerd's native brand

`hasCloudflareSqlExecInternal`, `hasNativeCloudflareSql` in `packages/realtime/src/cloudflare-sql.ts`.

**Context:** Room storage trusts `storage.sql` of a Durable Object request. Function sources and prototype layout vary between workerd versions, and copied native getters or Proxies can forge naive checks.

**Decision:** The check requires the constructor to own the prototype, rejects built-in container constructors, requires a native `databaseSize` getter source named `databaseSize`, `get databaseSize`, or nothing, and probes the receiver brand: the getter must reject Map/Set/ArrayBuffer-like receivers and an object that only copies the prototype, and return a finite size for the real one.

**Consequences:** Weakening any probe lets a counterfeit carrier act as Durable Object storage.

## Durable Object room tables add missing columns by checking `pragma_table_info`

`documentTables` and `addMissingColumn` in `packages/realtime/src/internal/server.ts`.

**Context:** Rooms opened before `client_update` and `editor_version` existed keep tables without those columns. Durable Object SQLite accepts `ALTER TABLE ... ADD COLUMN` but rejects `PRAGMA user_version` with `SQLITE_AUTH`, so the schema cannot carry a version number. A second `ADD COLUMN` fails with "duplicate column name".

**Decision:** Room open creates the final tables, then adds each column that `pragma_table_info` does not list. Every read and write uses the final columns, with one SQL form per query.

**Consequences:** A new column needs its own `addMissingColumn` call. A failing ALTER now fails the room open instead of falling back to fewer columns.

## Pre-adapter Durable Object rooms are copied into the current journal

`migrateLegacyDocument` in `packages/realtime/src/internal/server.ts`.

**Context:** Releases from 2026-08-09 to 2026-10-16 stored Durable Object rooms in `vitehub_realtime_rooms` and `vitehub_realtime_updates`. Some of them wrote the room without its update journal. Whether any deployed Durable Object still holds such a room is not known.

**Decision:** When `vitehub_realtime_rooms` exists and the room has no current row, room open copies the room and, when `vitehub_realtime_updates` exists, its updates. It checks `sqlite_master` for each table instead of catching the error of a missing one.

**Consequences:** Deleting the migration loses the unsaved edits of a pre-adapter room. It can go once no deployed Durable Object holds those tables.

## The editor rewrites escaped GitHub alert markers after @tiptap/markdown renders

`escapedAlertMarker` and `RealtimeBlockquote` in `packages/realtime/src/editor.ts`.

**Context:** @tiptap/markdown escapes every bracket in text, so it writes `> [!NOTE]` as `> \[!NOTE\]`, which GitHub renders as a plain quote.

**Decision:** `RealtimeBlockquote` renders through the Blockquote extension, then turns an escaped alert marker on the first line back into `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, or `[!CAUTION]`.

**Consequences:** Without the rewrite, every saved alert loses its type. It can go when @tiptap/markdown keeps alert markers or ViteHub adds an alert node with its own `renderMarkdown`.

