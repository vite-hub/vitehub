---
title: Edit Content together
description: Show who has a document open, give one session at a time the edit lease, and refuse writes from everyone else.
navigation.title: Editing together
navigation.order: 5
icon: i-lucide-users
---

Several people and Agents can open the same document. Content keeps a session per editor tab or client in the Database of the Workspace history. A session says who has the document open and whether they view or edit it. One session at a time holds the **edit lease** of a document. While it does, saves from anyone else fail with `CONTENT_LEASE_HELD` and name the holder.

`ifDigest` stays the real write guarantee. A lease decides who should be typing; the digest decides whether a save lands on the version it read. Every save still passes both checks.

## Add the sessions table

Sessions live in the Database that already holds the Workspace history, so they work on every host with the Blob + Database Store: libSQL, Turso, and Cloudflare D1. Add `contentSessionsSchema` next to `workspaceHistorySchema`:

```ts [server/databases/content/config.ts]
import { defineDatabase } from 'vite-hub/database'
import { contentSessionsSchema } from 'vite-hub/content/database'
import { workspaceHistorySchema } from 'vite-hub/workspace/blob-database'

export default defineDatabase({
  name: 'content',
  schema: { ...workspaceHistorySchema, ...contentSessionsSchema },
})
```

Run `vitehub db generate` and `vitehub db migrate`. Content finds the Database through the Workspace Store, so `defineContent()` takes no new option.

Without the table, `content.sessions` throws `CONTENT_R0012` and names this fix. Saves keep working and skip the lease check, because nobody can hold a lease. The Console stays editable and shows that it cannot check who else is editing.

## Sessions

A session is a token you generate per tab or client, such as `crypto.randomUUID()`. Use one per editor instance, not one per user. Two tabs of the same person are two sessions, so the second tab sees that the first one holds the lease instead of overwriting it.

```ts [server/api/editor/session.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { content } from '../../content'

export default defineEventHandler(async (event) => {
  const { id, session, kind, input } = await readBody(event)
  const user = { id: 'ana', name: 'Ana' } // the signed-in user
  return await content.sessions.report('posts', id, { session, user, kind, input })
})
```

| Method | Behavior |
| --- | --- |
| `content.sessions.report(collection, id?, { session, user, kind, input? })` | Keeps the session present for 45 seconds. `kind: 'edit'` renews the lease the session holds; it never takes a free one. `kind: 'view'` drops the lease. `input: true` records that the user typed since the last report. |
| `content.sessions.acquire(collection, id?, { session, user, takeover? })` | Takes the lease for 5 minutes when no other session holds it. `takeover: true` takes it from the holder, who keeps viewing. Check `editing` in the result. |
| `content.sessions.release(collection, id?, { session })` | Removes the session from the document and frees its lease. Call it when the editor closes. |
| `content.sessions.list(collection?)` | Every live session, of one collection or of all, for list rows and dashboards. |

Omit `id` for a singleton. `user` is `{ id, name?, image? }`: the signed-in user, or the Actor of an Agent.

`report()` and `acquire()` return the document's sessions after the call:

```ts
{
  collection: 'posts',
  id: 'hello',
  editing: false,              // this session may edit
  holder: {                    // who holds the lease, or null
    session: 'tab-…', kind: 'edit', since: '2026-10-14T10:42:00.000Z',
    user: { id: 'ben', name: 'Ben', image: null },
    seenAt: '…', expiresAt: '…', inputAt: '…',
  },
  sessions: [/* every live session, editors first */],
  lease: true,                 // false with editing: { lease: false }
  now: '2026-10-14T10:44:10.000Z',
}
```

`now` comes from the Database clock. Compare `since` and `expiresAt` with it instead of the local clock.

## Timing

All times use the Database clock, so hosts with skewed clocks still agree on who holds a lease.

| Rule | Value |
| --- | --- |
| A session stays present after a report | 45 seconds |
| A lease lasts after `acquire()`, a renewing report, or a save with `session` | 5 minutes |
| A lease stops blocking others after no reported input | 15 minutes |

A lease without input for 15 minutes still shows its session, as viewing. Another session can then acquire the lease without `takeover`. The idle session reclaims it with `acquire()` on its next keystroke when it is still free.

Report about every 15 seconds while the tab is visible and every 60 seconds while it is hidden. Browsers run timers of a hidden tab about once a minute, so a 5-minute lease outlives the throttling. Call `acquire()` on the first edit, not when the document opens, and call `release()` on `pagehide` with `fetch(..., { keepalive: true })` or `navigator.sendBeacon()`.

## Writes and leases

`save()`, `remove()`, and `restore()` read the lease once before they commit.

```ts
const posts = content.collection('posts')

// The holder's own tab: its lease does not block it, and the save renews it.
await posts.save('hello', input, { ifDigest, session })

// An Agent, a CLI, or a route without a session: fails while someone holds the lease.
await posts.save('hello', input)

// Write anyway.
await posts.save('hello', input, { lease: 'override' })
```

| Option | Behavior |
| --- | --- |
| `session` | The caller's session token. Its own lease does not block the write, and the write renews it. |
| `lease: 'override'` | Write even while another session holds the lease. |

The error is `CONTENT_LEASE_HELD` with `details: { collection, id, holder: { user, since, expiresAt } }`. The Console returns it as a `409`. Writes succeed when nobody holds a lease, so Agents, the CLI, and API routes keep working on documents no one has open. They honor leases by default and override only when you pass `lease: 'override'`. [`vitehub content edit`](/docs/content/cli#edit-leases) passes it only with `--override-lease`.

`publish()` and `schedule()` do not check leases. They publish the reviewed digests from `expect`, and a draft saved after review already fails with `WORKSPACE_CONFLICT`.

## Opt out per collection

Some collections are edited by many people at once, such as a shared notes list, or only by code. Turn the lease off:

```ts [server/content.ts]
notes: documents({ path: 'notes/*.md', fields, editing: { lease: false } }),
settings: singleton({ path: 'settings.json', fields, editing: { lease: false } }),
```

Sessions still report presence, and `kind: 'edit'` shows who edits. `acquire()` always succeeds, `holder` is always `null`, and writes never fail with `CONTENT_LEASE_HELD`. `collection.editing.lease` reports the setting.

## Live editing

Where Realtime runs, several people edit one Markdown document at the same time. Turn on Realtime next to Content:

```ts [vite.config.ts]
vitehub({
  preset: 'node',
  console: { auth: 'app' },
  realtime: { authority: 'memory' },
})
```

`vite dev` uses the memory authority without the option. A Node build needs `authority: 'memory'` (one server process), and a Cloudflare build uses Durable Objects. On Vercel, Netlify, and Deno there is no room authority: the build succeeds and Content keeps one editor at a time, as described above. Set `defineContent({ live: false })` to keep one editor at a time everywhere.

### What people see

- Opening a document joins its live room. Everyone in it edits the fields and the body together. The body shows a named caret per person, and each property row shows who has it in focus.
- The header shows the people in the room and **Live**. The room saves the draft 2 seconds after typing stops, at most every 10 seconds, and when the last person leaves. ⌘S, Publish, and Schedule save first. Each revision in History names everyone who edited it, such as `Ana and Ben`.
- Drafts in progress save with their field issues, which show inline. Publish waits until they are fixed.
- A body with Markdown the editor cannot keep, such as an undeclared component, a task list, or a heading id, opens read-only in the room. The page names the construct, and Source stays editable by one person at a time under the edit lease.
- A save from outside the room, such as an Agent, the CLI, or another route, reloads the room. Someone with edits the room had not saved yet gets **Copy your unsaved edits**.
- Where live editing is unavailable, a page that someone else has open shows **Live editing unavailable · one editor at a time**.

### The live lease

The room holds the edit lease as `kind: 'live'` for everyone in it, from the first person who joins with write access until the last one leaves and the room saved. `user.name` of the lease lists the people, such as `Ana, Ben`. Others see **Live session: Ana, Ben** and join instead of taking over. Writes from outside the room fail with `CONTENT_LEASE_HELD` naming the live session, unless they pass `lease: 'override'`; the room then reloads. The sessions table stores `kind` as text, so `live` needs no migration.

### Build your own live editor

ViteHub generates one Realtime Definition named `content`. Its rooms are `<collection>/<id>`, or the collection name of a singleton. It identifies people with the Console session when the Console is enabled, otherwise with the ViteHub Auth session, and `authorize` maps to `content.can()`: reading a room needs `read`, editing needs `write`.

```ts [app editor]
import { contentRealtimeEditor } from 'vite-hub/content/editor'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

const editor = contentRealtimeEditor(posts) // the same codec the server uses
const realtime = useRealtimeTiptap('content', 'posts/hello', { editor })
```

`contentRealtimeEditor(collection)` builds the comark-tiptap schema of a collection from its `components`, without a DOM. Browser editors that add node views build their components with `contentEditorComponents()`, so both schemas match. `contentMarkdownLoss()` is the check `verify()` uses: it ignores attribute order, declared prop defaults, and reference links written inline.

`vite-hub/content/realtime` also exports `contentDocument(collection)`, the Realtime document adapter of one collection, and `contentRealtime(content, { identify, authorize, user })` to define the room yourself in `server/realtime/content.ts`. A file with that name replaces the generated one.

## Limits

- Leases are advisory for reads and enforced for writes through Content. A Workspace writer that bypasses Content, such as a raw history commit, does not check them.
- The lease check and the commit are two steps. A lease taken between them does not stop that one save; `ifDigest` still protects the bytes.
- Each write with leases on runs one extra Database query. Each `report()` and `acquire()` is one atomic batch.
- Rows of sessions that expired more than an hour ago are deleted on the next report in the same Workspace.
- Live editing covers Markdown documents. JSON and YAML documents keep one editor at a time.
- A room that does not answer within 8 seconds leaves the page to one editor at a time.
- On Cloudflare, an outside write reloads a room only while its Durable Object is in memory. A room that wakes up later loads the stored document, because its digest changed.
