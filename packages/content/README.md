# @vite-hub/content

ViteHub content integration for Comark Content: read-only Sources and editable document collections.

Pass ViteHub Source definitions, registered names, readers, reader factories, or native Comark raw Sources. A single source becomes a named `default` instance. Named sources are composed with Comark's `contentHub()`, with ViteHub adapters for named cache operations and positional search arguments.

```ts
import { defineContent } from "@vite-hub/content"
import fs from "comark-content/sources/fs"

export const content = defineContent({
  sources: {
    docs: fs("./docs"),
    blog: fs("./blog"),
  },
})
```

`defineContent()` forwards Comark plugins to each content instance. Install the
plugin you need and pass it in `plugins`; plugin options are evaluated when the
content runtime is created and can be changed by rebuilding or recreating that
runtime.

```ts
import knap from "comark-knap"

export const content = defineContent({
  plugins: [
    knap({
      variables: {
        environment: process.env.NODE_ENV,
      },
    }),
  ],
  source: fs("./docs"),
})
```

Use per-render Markdown APIs when plugin values must come from an individual
request or invocation. Content parsing and cache refreshes use the plugin list
configured on the content runtime.

Use `contentSource(input, { prefix, schema })` to configure a Source. Adapted Sources retain one reader per asynchronous load, including overlapping refreshes. `defineContentHandler()` adapts the Comark Web handler to H3 events.

## Document collections

`collections` stores Markdown documents in a Workspace with retained history, such as the Blob + Database Store. `fields` is a record of Standard Schema validators, one per frontmatter field, so validators from different libraries mix. Wrap a validator without `.optional()` in `optional()`. `@vite-hub/content` exports every field helper: `image()` and `file()` from Blob, `seo()`, and `optional()`.

```ts
import { defineContent, documents } from "@vite-hub/content"
import { z } from "zod"

export const content = defineContent({
  workspace: "site",
  collections: {
    posts: documents({
      path: "posts/**/*.md",
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
  },
  authorize: ({ user, actor, action }) => user?.role === "editor" && (actor === undefined || action !== "publish"),
})

const posts = content.collection("posts")
const saved = await posts.save("hello", { data: { title: "Hello", date: "2026-10-14" }, body: "# Hello" }, { ifDigest: null })
await posts.list({ ref: "draft", filter: { tags: "vue" }, sort: { field: "date", direction: "desc" } })
await posts.status("hello") // { collection: "posts", id: "hello", state: "draft", draft: saved.digest, published: null }
await posts.raw("hello", { ref: "draft" }) // the stored file, even if it no longer validates
await content.publish({ expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
await content.revisions("posts", "hello")
content.collections() // [posts], each with name, kind, format, path, fields, and schema
```

`documents({ label, titleField })` names a collection, such as `label: { singular: "Person", plural: "People" }`, and the string field that names a document. Without them the label is the name in title case, and the title field is the first of `title`, `name`, `label`, and `heading`, then the first required string field. `singleton()` takes a `label` string and `titleField` too.

`singleton({ path, fields })` defines one document at a fixed path, such as site settings. Its methods take no id, and `publish({ expect })` entries for it may omit `id`. The extension sets the format of a document or collection: `.json` stores an indented JSON object, `.yaml`/`.yml` a block-style YAML mapping, and anything else Markdown with YAML frontmatter. JSON and YAML documents have no body.

```ts
import { defineContent, documents, singleton } from "@vite-hub/content"

export const content = defineContent({
  workspace: "site",
  collections: {
    settings: singleton({ path: "settings.json", fields: { title: z.string(), social: z.array(z.url()).default([]) } }),
    authors: documents({ path: "authors/*.yaml", fields: { name: z.string() } }),
  },
})

const settings = content.collection("settings") // kind: "singleton", id: "settings"
const draft = await settings.save({ data: { title: "ViteHub" } })
await content.publish({ expect: [{ collection: "settings", digest: draft.digest }] })
await settings.get() // the published settings, also at /api/content/get/settings
```

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve only `published`. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths: the `draft` ref accepts fields in progress, every other ref only valid documents. `save()` stores invalid fields and returns them as `issues`; `publish()` and `schedule()` refuse such drafts with `CONTENT_INVALID` naming each one. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. `publish({ expect })` publishes exactly the reviewed draft digests and throws `WORKSPACE_CONFLICT` when one changed, so confirm and approve flows use it. Listed documents carry `updatedAt`, when each last changed on the ref read. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can({ user, actor })` first, where `user` is the Auth user and `actor` is the Agent Actor, if any. Zod date fields project to `date-time` strings in `schema`; plain Valibot fields need no wrapper, because Content converts them as Agent tools do, and Content warns once for each field whose JSON Schema is empty.

The `content()` Agent Capability from `@vite-hub/agent/capabilities` gives an Agent tools to list, read, save drafts, and publish, typed by each collection's fields. It checks `content.can()` with the Invocation's Actor, and publishing requires approval by default.

`content.sessions` keeps presence and edit leases in the Database of the Workspace history: `report()` every 15 seconds, `acquire()` on the first edit, `release()` when the editor closes, and `list()` for list rows. While one session holds a document's lease, `save()`, `remove()`, and `restore()` from other callers throw `CONTENT_LEASE_HELD`; pass `{ session }` from the holder's tab, or `{ lease: "override" }`. Add `contentSessionsSchema` from `@vite-hub/content/database` next to `workspaceHistorySchema`. `documents({ editing: { lease: false } })` keeps presence without the lease.

With Realtime enabled on a host with a room authority, ViteHub contributes a `content` Realtime Definition from `contentRealtime(content)` in `@vite-hub/content/realtime`: several people edit one Markdown document at once, the room saves into `draft` with `ifDigest`, and it holds the edit lease as `kind: 'live'`. `contentRealtimeEditor(collection)` and `contentMarkdownLoss()` in `@vite-hub/content/editor` are the codec and the loss check that the room and the Console share. `defineContent({ live: false })` keeps one editor at a time.

## SEO

`content.schedule({ at, expect })` publishes exactly the reviewed draft digests at a later time. A Schedule Definition such as `defineSchedule({ cron: "* * * * *", handler: () => content.publishDue() })` runs due schedules on every Schedule host. A draft saved after scheduling makes the run publish nothing and the schedule `failed`, with the `WORKSPACE_CONFLICT` details, until `unschedule(id)` dismisses it. `content.schedules()` lists pending, overdue (more than five minutes late without a run), and failed schedules, and `status()` reports each document's `schedule`. Schedules are JSON files on the `schedules` ref of the Content Workspace, so every change is a revision.

`documents({ url: "/blog/:id" })` maps documents to public URLs, and reads carry `document.url`. `seo()` is a field for per-document `{ title, description, image, canonical, noindex }`; pass `seo({ image: image() })` to store a Blob reference. `contentHead(document, { collection, site, defaults })`, also exported from `@vite-hub/content/client`, returns unhead-shaped `{ title, meta, link, script? }` that merge the `seo()` values, the document fields, and site defaults. It finds the `seo()` field of `collection` by its marker, and resolves Blob images with the served route of the generated Blob config. `defineContent({ seo: { site, sitemap: true, robots: true } })` makes ViteHub generate `/sitemap.xml` and `/robots.txt`; `content.sitemap()` and `content.robots()` return the same output.

```ts
useHead(contentHead(post, { site: { url: "https://vitehub.dev", name: "ViteHub" }, defaults: { description: settings.data.description } }))
```

## CLI

`hubContent()` from `@vite-hub/content/vite` contributes `vitehub content` when the app defines `server/content.ts`. The `vite-hub` framework distribution adds it for you.

```bash
vitehub content collections
vitehub content list <collection> [--ref published] [--search <text>]
vitehub content show <collection> [id] [--ref published]
vitehub content status [collection] [id]
vitehub content diff <collection> [id]
vitehub content revisions <collection> [id] [--ref published]
vitehub content edit <collection> [id] [--file <path>|-] [--if-digest <digest>] [--override-lease]
vitehub content publish [--collection <name>] [--id <id>...] [--dry-run] [--yes]
vitehub content schedule --at <time> [--collection <name>] [--id <id>...] [--dry-run] [--yes]
vitehub content scheduled [collection] [id] [--status pending|overdue|failed]
vitehub content unschedule <schedule>
vitehub content sitemap [--site <url>] [--xml]
```

Omit the id for a singleton. `edit` saves drafts with field issues and prints them; it honours edit leases unless `--override-lease`. `publish` and `schedule` pin the draft digests they list and refuse drafts with field issues. Every command accepts `--json`. The commands call a guarded endpoint that exists only on the Vite Development Server, which forwards each operation into the Nitro dev environment where `server/content.ts` runs. They do not reach a deployed app. `handleContentDevRequest()` from `@vite-hub/content/runtime/dev` is the Nitro handler; it is not a public runtime API.
