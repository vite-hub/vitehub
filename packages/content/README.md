# @vite-hub/content

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcontent&icon=npm)](https://www.npmjs.com/package/@vite-hub/content)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fcontent&period=month&icon=npm)](https://www.npmjs.com/package/@vite-hub/content)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

ViteHub content integration for Comark Content: read-only Sources and editable document collections.

Pass ViteHub Source definitions, registered names, readers, reader factories, or native Comark raw Sources. A single source becomes a named `default` instance. Named sources are composed with Comark's `contentHub()`, with ViteHub adapters for named cache operations and positional search arguments.

```ts
import { defineContent } from "@vite-hub/content"
import { glob } from "@vite-hub/source/glob"

export const content = defineContent({
  sources: {
    docs: glob({ cwd: "docs", include: "**/*.md" }),
    blog: glob({ cwd: "blog", include: "**/*.md" }),
  },
})
```

`defineContent()` forwards plugins to each content instance. Comark parse
plugins, which change how Markdown is parsed, go in `markdown.plugins`. Comark
Content plugins, such as `json()`, `media()`, or `sqlite-full-text-search`, go in
`plugins`. A parse plugin in `plugins` throws `CONTENT_R0006`. Plugin options are
evaluated when the content runtime is created and can be changed by rebuilding
or recreating that runtime.

```ts
import knap from "comark-knap"

export const content = defineContent({
  markdown: {
    plugins: [
      knap({
        variables: {
          environment: process.env.NODE_ENV,
        },
      }),
    ],
  },
  source: glob({ cwd: "docs", include: "**/*.md" }),
})
```

Use per-render Markdown APIs when plugin values must come from an individual
request or invocation. Content parsing and cache refreshes use the plugin list
configured on the content runtime.

Use `contentSource(input, { prefix, schema })` to configure a Source. Adapted Sources retain one reader per asynchronous load, including overlapping refreshes. `defineContentHandler()` adapts the Comark Web handler to H3 events.

## Markdown rendering

Content parses Markdown with the [Comark UI](https://comark-ui.onmax.me) preset, excluding the HTML-only `annotate`, `diff`, and `quiz` plugins that have no Vue renderers. Callouts, steps, tabs, cards, badges, diagrams, and tables use its parsers. `markdown.plugins` adds plugins; a plugin with a preset plugin's name replaces it. Content plugins still go in `plugins`. HTML-only blocks need an explicit parser plugin and application component override.

Render a page with ViteHub UI. Its `Markdown` primitive accepts both a parsed Content page and a Markdown string, with Comark UI components and document styles already configured:

```vue
<script setup lang="ts">
import { Markdown } from "@vite-hub/ui/markdown"

const { data: page } = await useFetch("/api/content/get/docs/introduction")
</script>

<template>
  <Markdown v-if="page" :value="page" />
</template>
```

With the framework distribution, import from `vite-hub/ui/markdown`. The UI Nuxt module auto-imports `Markdown`. There is no separate Comark UI install, component map, or stylesheet to configure. Pass `components` only to override a renderer for your application.

Content bundles Comark UI's parser and editor implementation and installs the Comark and Tiptap runtimes it needs. It leaves Vue to the UI package. Nuxt UI supplies the application's theme tokens; Nuxt UI Prose components are not needed. The preset's file include plugin stays off. Content leaves badge and chip images as URLs instead of downloading them during parsing. Icons and diagrams use Comark UI's default resolvers; override their plugins in `markdown.plugins` for an offline or private renderer.

## Document collections

`collections` stores Markdown documents in a Workspace with retained history, such as the Blob + Database Store. Import `documents()` and `optional()` from `@vite-hub/content/collections` and install `@vite-hub/workspace`; `@vite-hub/content` alone does not install Workspace or Database. `fields` is a record of Standard Schema validators, one per frontmatter field, so validators from different libraries mix. Wrap a validator without `.optional()` in `optional()`. `@vite-hub/content` exports every field helper: `image()` and `file()` from Blob, `seo()`, and `optional()`.

```ts
import { defineContent } from "@vite-hub/content"
import { documents } from "@vite-hub/content/collections"
import cms from "@vite-hub/content/presets/cms"
import { z } from "zod"

export const content = defineContent({
  extends: cms,
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

To keep documents in a Git repository, pass `extends: [cms, { store: "github", repo: "owner/name" }]`. Published content is on `branch` (default `main`) and drafts on `draftBranch` (default `vitehub/content`), created by the first save. The preset needs a Database for editor sessions and no Blob store. `publish: "commit"` is the only mode, `content.schedule()` throws `CONTENT_R0016`, and digests are Git blob shas. Options: `store`, `repo`, `branch`, `draftBranch`, `root` (default `""`, the repository root), and `publish`. See the [CMS preset docs](https://vitehub.dev/docs/content/cms-preset#github-store).

`documents({ label, titleField })` names a collection, such as `label: { singular: "Person", plural: "People" }`, and the string field that names a document. Without them the label is the name in title case, and the title field is the first of `title`, `name`, `label`, and `heading`, then the first required string field. `singleton()` takes a `label` string and `titleField` too.

`singleton({ path, fields })` defines one document at a fixed path, such as site settings. Its methods take no id, and `publish({ expect })` entries for it may omit `id`. The extension sets the format of a document or collection: `.json` stores an indented JSON object, `.yaml`/`.yml` a block-style YAML mapping, and anything else Markdown with YAML frontmatter. JSON and YAML documents have no body.

```ts
import { defineContent } from "@vite-hub/content"
import { documents, singleton } from "@vite-hub/content/collections"

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

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve `published`, except to a request with a valid preview cookie. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths: the `draft` ref accepts fields in progress, every other ref only valid documents. `save()` stores invalid fields and returns them as `issues`; `publish()` and `schedule()` refuse such drafts with `CONTENT_INVALID` naming each one. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. `publish({ expect })` publishes exactly the reviewed draft digests and throws `WORKSPACE_CONFLICT` when one changed, so confirm and approve flows use it. Listed documents carry `updatedAt`, when each last changed on the ref read. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can({ user, actor })` first, where `user` is the Auth user and `actor` is the Agent Actor, if any. Zod date fields project to `date-time` strings in `schema`; wrap Valibot fields in `toStandardJsonSchema()`, and Content warns once for each field whose JSON Schema is empty.

## Draft preview

`content.preview.enable(event)` signs an HMAC token with `VITEHUB_CONTENT_KEY` (32 random bytes as base64 or hex) and sets it as an `HttpOnly`, `SameSite=Strict` cookie for one hour by default. A request with a valid cookie reads `draft` through `/api/content/**`, `content.get()`/`list()`/`navigation()`/`search()`, and collection `get()`/`list()`, and gets `Cache-Control: private, no-store`. The grant lives in `AsyncLocalStorage` for that request only.

```ts
if (!await content.can({ user, collection: "posts", action: "read" })) throw createError({ statusCode: 403 })
await content.preview.enable(event, { maxAge: 900 })
content.preview.disable(event)
await content.preview.run(event, () => content.collection("posts").get("hello")) // outside Nitro
```

ViteHub generates a `defineContentPreviewPlugin()` Nitro plugin for Nitro 3 and Nuxt 4 (Nitro 2) apps. It wraps Nitro's request entry, so pages and server routes read drafts without changes, and Nitro's cached handlers, `cache`/`swr` route rules, and cached functions skip preview requests. Without the key, preview works only when `NODE_ENV` is `development` or `test`; elsewhere `enable()` throws `CONTENT_R0010` and cookies are ignored.

The `content()` Agent Capability from `@vite-hub/agent/capabilities` gives an Agent tools to list, read, save drafts, publish, and schedule collections and singletons, typed by each collection's fields. It checks `content.can()` with the Invocation's Actor and the Auth user it stands for, for each document it shows or changes. Publishing, scheduling, and cancelling a schedule require approval by default and use exactly the draft digests in the call. Saves honor edit leases unless the Capability sets `lease: "override"`.

`content.sessions` keeps presence and edit leases in the Database of the Workspace history: `report()` every 15 seconds, `acquire()` on the first edit, `release()` when the editor closes, and `list()` for list rows. While one session holds a document's lease, `save()`, `remove()`, and `restore()` from other callers throw `CONTENT_LEASE_HELD`; pass `{ session }` from the holder's tab, or `{ lease: "override" }`. Add `contentSessionsSchema` from `@vite-hub/content/database` next to `workspaceHistorySchema`. `documents({ editing: { lease: false } })` keeps presence without the lease.

With Realtime enabled on a host with a room authority, ViteHub contributes a `content` Realtime Definition from `contentRealtime(content)` in `@vite-hub/content/realtime`: several people edit one Markdown document at once, the room saves into `draft` with `ifDigest`, and it holds the edit lease as `kind: 'live'`. `contentRealtimeEditor()` in `@vite-hub/content/editor` adapts Comark UI's shared editor codec to the room. The Console uses `createContentEditorCodec()` from that same entry, with the same schema and loss check; unknown components, slots, task lists, and media survive an edit. `defineContent({ live: false })` keeps one editor at a time.

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
