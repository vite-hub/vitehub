---
title: Edit Content together
description: Show who has a document open, give one session at a time the edit lease, and refuse writes from everyone else.
navigation.title: Editing together
navigation.order: 10
icon: i-lucide-users
---

Many people and Agents can open one document. Content stores a session per editor tab or client in the Workspace history Database. It says who has the document open, viewing or editing. One session at a time holds the **edit lease**. Saves from anyone else fail with `CONTENT_LEASE_HELD` and name the holder.

`ifDigest` stays the real write guarantee. The lease decides who should type. The digest decides if a save lands on the version it read. Saves pass both checks.

## Add the sessions table

Sessions live in the Workspace history Database, so they work on every host with the Blob + Database Store: libSQL, Turso, and Cloudflare D1. Add `contentSessionsSchema` next to `workspaceHistorySchema`:

```ts [server/databases/content/index.ts]
import { defineDatabase } from 'vite-hub/database'
import { contentSessionsSchema } from 'vite-hub/content/database'
import { workspaceHistorySchema } from 'vite-hub/workspace/blob-database'

export default defineDatabase({
  name: 'content',
  schema: { ...workspaceHistorySchema, ...contentSessionsSchema },
})
```

Run `vitehub database generate` and `vitehub database migrate`. Content finds the Database through the Workspace Store, so `defineContent()` needs no new option. The examples on this page edit this `posts` collection:

```ts [server/content.ts]
import { cms } from 'vite-hub/cms'
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string() } }),
  },
})
```

Without the table, `content.sessions` throws `CONTENT_R0012` with this fix. Saves skip the lease check. The Console stays editable and says it cannot see who else edits.

## Sessions

A session is a token you make per tab or client, such as `crypto.randomUUID()`, not per user. Two tabs of one person are two sessions, so the second tab sees the first one's lease and does not overwrite it.

```ts [server/api/editor/session.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import content from '../../content'

const body = v.object({ id: v.string(), session: v.string(), kind: v.picklist(['view', 'edit']), input: v.optional(v.boolean()) })

export default defineEventHandler(async (event) => {
  const { id, session, kind, input } = await readValidatedBody(event, body)
  const user = { id: 'ana', name: 'Ana' } // the signed-in user
  return await content.sessions.report('posts', id, { session, user, kind, input })
})
```

| Method | Behavior |
| --- | --- |
| `content.sessions.report(collection, id?, { session, user, kind, input? })` | Keeps the session present for 45 seconds. `kind: 'edit'` renews a lease the session holds, but never takes a free one. `kind: 'view'` drops the lease. `input: true` records that the user typed since the last report. |
| `content.sessions.acquire(collection, id?, { session, user, takeover? })` | Takes a free lease for 5 minutes. `takeover: true` takes it from the holder, who keeps viewing. Check `editing` in the result. |
| `content.sessions.release(collection, id?, { session })` | Removes the session and frees its lease. Call it when the editor closes. |
| `content.sessions.list(collection?)` | Every live session, of one collection or all, for lists and dashboards. |

Omit `id` for a singleton. `user` is `{ id, name?, image? }`: the signed-in user, or an Agent's Actor.

`report()` and `acquire()` return the document's sessions after the call:

```ts fragment
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

`now` comes from the Database clock. Compare `since` and `expiresAt` with it, not with the local clock.

## Timing

All times use the Database clock, so hosts with skewed clocks agree on who holds a lease.

| Rule | Value |
| --- | --- |
| A session stays present after a report | 45 seconds |
| A lease lasts after `acquire()`, a renewing report, or a save with `session` | 5 minutes |
| A lease stops blocking others after no reported input | 15 minutes |

After 15 minutes without input, the session shows as viewing, and another session can acquire the lease without `takeover`. The idle session can take a still-free lease back with `acquire()` on its next keystroke.

Report about every 15 seconds while the tab is visible, and every 60 seconds while it is hidden. Browsers run hidden-tab timers about once a minute, so a 5-minute lease outlives that. Call `acquire()` on the first edit, not on open. Call `release()` on `pagehide` with `fetch(..., { keepalive: true })` or `navigator.sendBeacon()`.

## Writes and leases

`save()`, `remove()`, and `restore()` read the lease once before they commit.

```ts [server/utils/save-post.ts]
import content from '../content'

const input = { data: { title: 'Hello' }, body: '# Hello' }

export async function savePost(session: string, ifDigest: string | null) {
  const posts = content.collection('posts')

  // The holder's own tab: its lease does not block it, and the save renews it.
  await posts.save('hello', input, { ifDigest, session })

  // An Agent, a CLI, or a route without a session: fails while someone holds the lease.
  await posts.save('hello', input)

  // Write anyway.
  await posts.save('hello', input, { lease: 'override' })
}
```

| Option | Behavior |
| --- | --- |
| `session` | The caller's session token. Its own lease does not block the write, which renews it. |
| `lease: 'override'` | Write even while another session holds the lease. |

The error is `CONTENT_LEASE_HELD` with `details: { collection, id, holder: { user, since, expiresAt } }`, a `409` over the Console endpoint. Agents, the CLI, and API routes write freely to documents nobody has open, and honor leases unless you pass `lease: 'override'`. [`vitehub content edit`](/docs/content/cli#edit-leases) passes it only with `--override-lease`.

Other Workspace writers to the draft check leases too, such as [`vitehub push`](/docs/workspace/server-api#work-on-a-ref-in-a-local-folder), a raw `history.commit()`, or an Agent's `workspace.commit`. The `vitehub.content` Workspace plugin refuses a commit that writes or deletes a document that another session holds, with `CONTENT_LEASE_HELD` and status 409. Nothing is saved. One error names every held document of the commit: `details` has the first one as `collection`, `id`, and `holder`, and all of them in `documents`. To write anyway, put `lease: 'override'` in the revision metadata:

```bash [Terminal]
pnpm vitehub push --override-lease
```

```ts fragment
await workspace.history.commit({ ref: 'draft', ifHead, changes, metadata: { lease: 'override' } })
```

An Agent or an MCP client may override only when you allow it with `operations({ overrideLeases: true })`. Content's own writes, such as saves, seeding the draft, publishing, live rooms, and schedules, checked the lease of their caller already and skip this check. The `published` ref and the working tree have no lease check.

`publish()` and `schedule()` do not check leases. They publish the reviewed digests from `expect`, and a draft saved after review already fails with `WORKSPACE_CONFLICT`.

## Opt out per collection

Turn the lease off for collections that many people edit at once, such as shared notes, or that only code edits:

```ts [server/content.ts] fragment
notes: documents({ path: 'notes/*.md', fields, editing: { lease: false } }),
settings: singleton({ path: 'settings.json', fields, editing: { lease: false } }),
```

Sessions still report presence, and `kind: 'edit'` shows who edits. `acquire()` always succeeds, `holder` is always `null`, and writes never fail with `CONTENT_LEASE_HELD`. `collection.editing.lease` shows the setting.

## Live editing

> [!NOTE]
> The live editor was part of the Console that the app served, which is removed. The Console edits with the edit lease. The rooms below stay for [your own live editor](#build-your-own-live-editor).

With Realtime, several people edit one Markdown document at the same time. Turn on Realtime next to Content:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    realtime: { authority: 'memory' },
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
      realtime: { authority: 'memory' },
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
      realtime: { authority: 'memory' },
    }),
  ],
})
```
:::
::

`vite dev` uses the memory authority by default. A Node build shares rooms across instances through Redis or Postgres with `REDIS_URL` or a Postgres Default Database, and keeps them in one process without either. Cloudflare uses Durable Objects. Vercel, Netlify, and Deno have no room authority: the build succeeds with one editor at a time. `defineContent({ live: false })` keeps one editor at a time everywhere.

### What people see

- Opening a document joins its live room, where everyone edits fields and body together. The body shows a named caret per person. Each property row shows who has it in focus.
- The header shows the people in the room and **Live**. The room saves the draft 2 seconds after typing stops, at most every 10 seconds, and when the last person leaves. ⌘S, Publish, and Schedule save first. Each History revision names everyone who edited it, such as `Ana and Ben`.
- Unfinished drafts save with their field issues, shown inline. Publish waits until they are fixed.
- A body with Markdown the editor cannot keep, such as a footnote definition the base parser drops, opens read-only and the page says why. Source stays editable by one person at a time under the edit lease.
- A save from outside the room, such as an Agent, the CLI, or another route, reloads the room. Anyone with unsaved edits gets **Copy your unsaved edits**.
- Without live editing, a page someone else has open shows **Live editing unavailable · one editor at a time**.

### The live lease

The room holds the edit lease as `kind: 'live'` for everyone in it. It holds it from when the first person with write access joins until the last one leaves and the room saves. Its `user.name` lists the people, such as `Ana, Ben`. Others see **Live session: Ana, Ben** and join instead of taking over. Outside writes fail with `CONTENT_LEASE_HELD` unless they pass `lease: 'override'`, which reloads the room. `kind` is stored as text, so `live` needs no migration.

### Build your own live editor

ViteHub generates one Realtime Definition named `content`. Its rooms are `<collection>/<id>`, or a singleton's collection name. It identifies people with the ViteHub Auth session. With the Console on, rooms check Console access instead, which takes only signed calls, so a browser editor needs the Console off. `authorize` maps to `content.can()`: reading a room needs `read`, editing needs `write`.

```ts [app editor]
import { contentRealtimeEditor } from 'vite-hub/content/editor'
import { useRealtimeTiptap } from 'vite-hub/realtime/vue'

const editor = contentRealtimeEditor() // the same codec the server uses
const realtime = useRealtimeTiptap('content', 'posts/hello', { editor })
```

`contentRealtimeEditor()` adapts `createContentEditorCodec()` from `vite-hub/content/editor`. Content bundles Comark UI and installs its editor runtimes. Server and browser share one generic schema for components, named slots, task lists, tables, and media, with no node definitions per collection. Comark UI owns Markdown conversion and the loss check. A body the codec cannot keep opens read-only with a link to Source.

`vite-hub/content/realtime` also exports `contentDocument(collection)`, one collection's Realtime document adapter. `contentRealtime(content, { identify, authorize, user })` defines the room yourself in `server/realtime/content.ts`, which replaces the generated one.

## Limits

- Leases are advisory for reads and enforced for writes to the draft, through Content or any other Workspace writer. Writes to the working tree of the Workspace, such as `fs` writes, do not check them.
- The lease check and the commit are two steps. A lease taken between them does not stop that one save; `ifDigest` still protects the bytes.
- Each write with leases on runs one extra Database query. Each `report()` and `acquire()` is one atomic batch.
- Rows of sessions that expired more than an hour ago are deleted on the next report in the same Workspace.
- Live editing covers Markdown documents. JSON and YAML documents keep one editor at a time.
- A room that does not answer within 8 seconds leaves the page to one editor at a time.
- On Cloudflare, an outside write reloads a room only while its Durable Object is in memory. A room that wakes later loads the stored document, because its digest changed.
