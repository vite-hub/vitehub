# @vite-hub/content

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=%40vite-hub%2Fcontent&icon=npm)](https://npmx.dev/package/@vite-hub/content)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=%40vite-hub%2Fcontent&period=month&icon=npm)](https://npmx.dev/package/@vite-hub/content)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

ViteHub content integration for Comark Content: read-only Sources and editable document collections.

Pass ViteHub Source definitions, registered names, readers, reader factories, or native Comark raw Sources. A single source becomes a named `default` instance. Named sources are composed with Comark's `contentHub()`, with ViteHub adapters for named cache operations and positional search arguments.

```ts
import { defineContent } from "@vite-hub/content"
import { glob } from "@vite-hub/source"

export default defineContent({
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

Install Comark when importing a parse plugin directly:

```sh
pnpm add comark
```

```ts
import { defineContent } from "@vite-hub/content"
import { glob } from "@vite-hub/source"
import headings from "comark/plugins/headings"

export default defineContent({
  markdown: {
    plugins: [
      // Read each page description from its first blockquote
      headings({ descriptionTag: "blockquote" }),
    ],
  },
  source: glob({ cwd: "docs", include: "**/*.md" }),
})
```

Use per-render Markdown APIs when plugin values must come from an individual
request or invocation. Content parsing and cache refreshes use the plugin list
configured on the content runtime.

`sqlite()` from `@vite-hub/content/sqlite` is an in-memory database for index
plugins such as `sqlite-full-text-search`. It uses Node SQLite on Node and
SQLite WASM on Cloudflare Workers, where the `workerd` export condition selects
it. When `server/content.ts` imports it, the generated
`.vitehub/content/sqlite.mjs` Nitro plugin loads it while the server starts,
because a Worker compiles WebAssembly only then.

Use `contentSource(input, { prefix, schema, url })` to configure a Source. `url`, such as `"/:id"`, lists the Source's documents in the sitemap; the id is the document path without its leading slash. Adapted Sources retain one reader per asynchronous load, including overlapping refreshes. `defineContentHandler()` serves the Comark Web handler as a Fetchable route, `{ fetch(request) }`. `defineContentSitemapHandler()`, `defineContentRobotsHandler()`, and `defineContentLlmsHandler()` return Fetchable routes too. `defineContentMarkdownHandler()` is H3 middleware, because it returns nothing to pass other requests on. It takes the Content runtime or a function that loads it; with a function, it loads Content only for requests that ask for Markdown. `@vite-hub/content/markdown` exports it without the Content runtime, for the generated middleware that loads when the server starts.

Set `route: false` in `defineContent()` to disable the public `/api/content/**` route.
Server reads, Console editing, draft preview, and configured SEO routes remain available.
`defineContentHandler(content)` also returns 404 when this option is false.

## Live GitHub Sources

A `github()` Source with a GitHub token is live. Content serves one commit of its branch, the head, and keeps the head in ViteHub KV under `content:head:<source>`. A push does not change what readers get until the head moves.

```ts
// server/content.ts
import { defineContent } from "@vite-hub/content"
import { github } from "@vite-hub/source"

export default defineContent({
  sources: { docs: github({ repo: "acme/docs", ref: "main" }) },
})
```

```ts fragment
await content.sources.head("docs") // { source: "docs", live: true, sha, ref: "main", movedAt, pinned: false, rejected: null, checkedAt, webhook, cache, views }
await content.sources.advance("docs") // move to the latest commit of main when every document parses
await content.sources.pin(sha, "docs") // serve this commit until unpin(), for example to roll back
await content.sources.unpin("docs")
```

- The first read resolves the branch, validates the commit, and stores the head when KV has none. A live Source without an accepted commit fails reads; `head()` still shows its rejection. After fixing a document or a temporary retrieval failure, call `advance()` to retry, including for the same SHA.
- `advance()` loads and parses every document of the latest commit. The head moves only when all of them parse. Otherwise the head stays on the last valid commit, `rejected` names the commit and the failing document, and Content logs `CONTENT_R0019`. A push with a broken document never reaches readers. The GitHub push webhook below calls `advance()` for you.
- Send first initialization and all `advance()`, `pin()`, and `unpin()` calls for each Source through one serialized writer. Initialize the head before starting read replicas. KV has no atomic conditional write: concurrent writers are unsupported and can overwrite a pin or a newer head.
- A pinned head does not move until `unpin()` within that writer contract. `pin()` takes a full 40-character commit SHA and validates it too.
- Each server instance holds the head in memory for 5 seconds. Read replicas check KV again after 5 seconds; provider consistency can delay visibility further. All Source reads, including SQL queries, sitemap, explicit initialization, and type generation, follow the selected head. GitHub Sources keep their parsed cache in memory per instance; they do not restore the shared `cache.driver`, which has no commit identity.
- Without a token, the Source is not live: each load reads the latest commit of its branch without validation, and Content logs `CONTENT_R0020` once. The token is `github({ auth })`, or the Server Env `VITEHUB_GITHUB_TOKEN`.
- ViteHub turns KV on when `server/content.ts` imports `github()` and `vitehub()` leaves `kv` unset. You do not add KV yourself. The head uses the `default` KV store. On Cloudflare, it is the KV namespace bound as `KV`. `vitehub kv get content:head:docs` shows the stored head.
- Without a KV store, such as with `kv: false` or when `server/content.ts` gets its Sources from another file, the Source is not live: it reads its branch as without a token, and Content logs `CONTENT_R0021` once.
- When the KV store fails on a read, the page does not fail. Content logs `CONTENT_R0022`, serves the commit that the server instance already serves, or else the latest commit of the branch, and tries KV again after 5 seconds. `head()`, `advance()`, `pin()`, and `unpin()` throw `CONTENT_R0022` to the caller.
- Without a push webhook, the head still moves: the first read one hour after the last check resolves the branch again and calls `advance()`. That read waits for the check. It takes a one-minute lease under `content:check:<source>` first, so other server instances do not check at the same time. Completed checks store `checkedAt` under `content:checked:<source>`. An unchanged branch needs no head write; a changed branch needs one. A failed check is tried again after the lease.

### GitHub push webhook

When `server/content.ts` imports `github` from `vite-hub/source`, ViteHub adds the route `POST /_vitehub/content/github`. A signed `push` to the branch of a `github()` Source moves its head within seconds, without a deploy.

1. Generate a secret, such as `openssl rand -hex 32`, and set it as `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env. `FORGES_GITHUB_WEBHOOK_SECRET` also works.
2. In the repository on GitHub, open Settings, Webhooks, Add webhook. Set the payload URL to `https://<your site>/_vitehub/content/github`, the content type to `application/json`, and the secret to the same value. Select "Just the push event".

The route checks `X-Hub-Signature-256` against the raw body in constant time, with the same verifier as Channels.

| Request | Response |
| --- | --- |
| No `VITEHUB_GITHUB_WEBHOOK_SECRET` in the Server Env | 404. Content logs `CONTENT_R0026` once. The hourly check still moves the head. |
| Missing or wrong signature | 401 with `CONTENT_R0024`. Nothing moves. |
| `ping` | 200 `{ ok: true }` |
| `push` to the branch of a Source | `advance()` for each matching Source. When the host gives the request `waitUntil`, such as Cloudflare Workers, 202 `{ sources }` and the work runs after the response. Otherwise 200 `{ sources, deliveries }`. |
| `push` to another branch, a deleted branch, or another event | 200 `{ ignored }` |
| `push` to a repository that no Source reads | 200, and Content logs `CONTENT_R0025`. |

A Source without `ref` follows the default branch in the payload. `content.sources.head()` shows the last delivery in `webhook`: `{ id, at, sha, result }`, where `id` is the `X-GitHub-Delivery` id and `result` is `moved`, `kept`, `rejected`, `pinned`, or `failed` with `error`. `vitehub kv get content:webhook:docs` shows the same record. A delivery with a bad signature writes nothing, so only the log shows it.

ViteHub adds the route only for an `import { github }` in `server/content.ts`. When the Source comes from another file, or in another server, mount `defineContentGitHubWebhookHandler(content)` as a Fetchable route.

### Commit cache

The files of a commit never change. Content downloads each commit once per cache key, and keeps the files and the parsed documents in KV under `content:<parserHash>:<sha>:<source>`. A new head reads a new key, so nothing purges a cache, on any host.

- A read tries memory first, then KV, then the GitHub archive. Validation and serving share one download: the first read of a commit downloads one archive, and a server instance with the commit in KV downloads none.
- `parserHash` hashes the Comark options, plugin source text, the Source fingerprint, its effective `prefix` and `schema`, and the build. Each build uses new keys.
- The built-in parser reuses parsed documents from KV. With custom `markdown.plugins` or Content `plugins`, each new runtime parses the cached files again without a download. Function source text cannot identify captured plugin options or implementations. Within one runtime, memory holds the parsed result.
- Content writes an artifact only after every document parses. A rollback with `pin()` to a valid commit reads it from the cache. A rejected load or failed download stays out of memory, so `advance()` can retry it.
- Each server instance holds the last 4 commits in memory.
- `head().cache` shows the key of the served commit, the reads from memory and from KV, and the misses. Each miss is one archive download. `vitehub kv get <key>` shows the stored commit. When KV refuses a value, for example one larger than 25 MiB on Cloudflare, Content logs `CONTENT_R0023` and other server instances download the commit again.

### Read a branch, a pull request, or a commit

`content.sources.at(ref, source?)` returns a read view of a `github()` Source at one commit. The view has `get()`, `list()`, `navigation()`, and `search()` for that Source only.

```ts fragment
const view = await content.sources.at("pr/12", "docs")
view // { source: "docs", ref: "pr/12", kind: "pull", sha, pull: { number: 12, fork: false, labels: ["preview:enabled"], head: "feat/x", base: "main", ... } }
await view.get("/guide")

await content.sources.at("feat/new-guide", "docs") // kind: "branch"
await content.sources.at("9c1e4f…", "docs") // kind: "commit", a full 40-character SHA
```

- A ref is a full 40-character commit SHA, `pr/<number>` for the head commit of a pull request, or a branch name. A branch name has up to 200 characters: letters, digits, and `. _ - /`. It follows `git check-ref-format`, and it cannot have a part that is only `-`. A branch named `pr/<number>` cannot open. An invalid ref fails with `CONTENT_R0027` before Content asks GitHub.
- Content resolves the ref to a commit SHA on GitHub. A branch must match its full name. It holds a branch or pull request lookup for 30 seconds, so a push shows after 30 seconds at most. A ref that the repository does not have fails with `CONTENT_R0028`, and a failed GitHub lookup, such as a rate limit, with `CONTENT_R0029`.
- The view reads the commit through the commit cache, so it validates like a head. When a document does not parse, `at()` fails with `CONTENT_R0030`. Refs at the same commit share one view and one download.
- Each server instance holds 8 views open, and closes the least recently used one. A closed view opens again on its next read, from the commit cache. `head().views` lists the open commits.
- A view works without a token or KV for a public repository. GitHub then allows 60 lookups per hour.
- `at()` does not check access, and Content serves no route for it. Draft branches, such as the CMS `vitehub/content` branch, and fork pull requests can hold content that is not public. Call `content.sources.allow()` first.

### Who may read a ref

GitHub serves the commits of a fork pull request through your repository, and the CMS keeps drafts on a branch of the same repository. So a route that serves `at()` must ask `content.sources.allow(ref, request, source?)` first. It decides before Content downloads the commit:

```ts fragment
const access = await content.sources.allow("pr/12", request, "docs")
if (!access.allowed) {
  console.warn(access.error) // CONTENT_R0031, with the reason
  return new Response("Not Found", { status: 404 })
}
const view = await content.sources.at(access.target) // the commit that allow() checked
```

| Ref | Public | Reason |
| --- | --- | --- |
| A commit, a branch, or a pull request whose commit the published branch contains | Yes | `published` |
| The head commit of an open or merged pull request from the same repository | Yes | `pull` |
| The head commit of an open or merged fork pull request with the `preview:enabled` label | Yes | `label` |
| A fork pull request without the label | No | `fork` |
| A pull request that was closed without a merge, unless the published branch contains its head | No | `closed` |
| A private branch, such as the CMS draft branch or a CMS publish branch (`vitehub/publish/*`), and a same-repository pull request from it | No | `private` |
| A branch or commit with no allowed pull request and outside the published history | No | `unpublished` |
| An invalid ref, or one that the repository does not have | No | `missing` |

- The published branch is the `ref` of the `github()` Source, or the default branch of the repository. Content asks GitHub `compare/<branch>...<sha>` and counts `behind` and `identical`.
- A request passes every rule with the preview cookie of `content.preview.enable()` (reason `console`), or with a link from `content.sources.sign(ref, source?, { maxAge })` (reason `token`). A link carries `?vitehub-content-token=<token>`, signs one ref of one Source, and expires after `maxAge` seconds: one hour by default, 24 hours at most. Both use `VITEHUB_CONTENT_KEY`. `sign()` is trusted server API: check `content.can()` or Console access before you call it. A request with the link parameter bypasses Nitro's cache and gets `private, no-store`, so a cached route does not answer an expired link.
- The `cms` preset with a GitHub store makes its `draftBranch` private. The pull requests that the CMS opens with `publish: "pr"` come from `vitehub/publish/*` branches, and these are always private: they hold drafts that nobody reviewed yet. A preset sets other private branches with `privateBranches`.
- Content holds each decision from GitHub for 10 minutes on each server instance. A removed label or a closed pull request shows after 10 minutes at most, also for a `target` or view that you keep: its pull request is read from GitHub again. A fork pull request counts for a commit SHA while it is one of the 100 most recently updated open pull requests, because GitHub does not list fork pull requests for a commit. A failed GitHub call holds nothing and throws `CONTENT_R0032`.
- Every denial is a 404 with no reason in the response. A route must not tell a private ref from a missing one. Log `access.error` instead.
- Different from comarkdown/comark-docs, which this rule follows: a branch of the same repository is not public only because it exists, and a SHA must be the head of a pull request, not any commit in it. A ref is a full SHA, not a short one.

## Types

In development, ViteHub writes `.vitehub/types/content.d.ts` with Comark's type generation. It types the `data` of `content.get()`, `content.list()`, and `content.query()` from the schema of each Source and collection: a collection uses its fields, and Comark infers a Source's schema from its documents. The generated `.vitehub/content/types.mjs` Nitro plugin sends declarations to the host process, which writes the file in the background when the server starts and after Content changes. A production build drops it. `generateContentTypes(content, { moduleName })` returns the same declarations. They extend Comark's `ContentRegistry` and `ContentPathsRegistry` through `@vite-hub/content`, or through `moduleName`, because an app that installs only ViteHub cannot resolve `comark-content` itself.

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

With the framework distribution, import from `vite-hub/ui/markdown`. There is no separate Comark UI install, component map, or stylesheet to configure. Pass `components` only to override a renderer for your application.

Without Vue, `renderContentHtml(await content.get(path), { components? })` renders a parsed document to an HTML string with the same Comark UI preset. The app does not install `@comark/html`.

Content bundles Comark UI's parser and editor implementation and installs the Comark and Tiptap runtimes it needs. It leaves Vue to the UI package. Nuxt UI supplies the application's theme tokens; Nuxt UI Prose components are not needed. The preset's file include plugin stays off. Content leaves badge and chip images as URLs instead of downloading them during parsing. Icons and diagrams use Comark UI's default resolvers; override their plugins in `markdown.plugins` for an offline or private renderer.

## Document collections

`collections` stores Markdown documents in a Workspace with retained history, such as the Blob + Database Store. Import `documents()` and `optional()` from `@vite-hub/content/collections` and install `@vite-hub/workspace`; `@vite-hub/content` alone does not install Workspace or Database. `fields` is a record of Standard Schema validators, one per frontmatter field, so validators from different libraries mix. Wrap a validator without `.optional()` in `optional()`. `@vite-hub/content` exports every field helper: `image()` and `file()` from Blob, `seo()`, and `optional()`.

`components` lists the Comark components that bodies may use, such as `alert` for `::alert`, and the Console editor offers them in its `/` menu. Each prop has a `type`: `string`, `number`, `boolean`, `json`, `image`, or `file`. An `image` or `file` prop opens the same Media picker as `image()` and `file()` fields, limited to `store` when set. It stores the picked file as a string attribute: the served URL, such as `/media/icons/train.webp`, or the Blob pathname when the store is not served. Content stores the Markdown as written and does not check component use.

```ts
import { z } from "zod"
import { documents } from "@vite-hub/content/collections"

documents({
  path: "notes/*.md",
  fields: { title: z.string() },
  components: { "field-note": { props: { title: { type: "string" }, icon: { type: "image", store: "media" } } } },
})
```

```ts
// server/content.ts
import { defineContent } from "@vite-hub/content"
import { documents } from "@vite-hub/content/collections"
import cms from "@vite-hub/cms"
import { z } from "zod"

const content = defineContent({
  extends: cms,
  collections: {
    posts: documents({
      path: "posts/**/*.md",
      fields: { title: z.string(), date: z.coerce.date(), tags: z.array(z.string()).default([]) },
    }),
  },
  authorize: ({ user, actor, action }) => user?.role === "editor" && (actor === undefined || action !== "publish"),
})

export default content

const posts = content.collection("posts")
const saved = await posts.save("hello", { data: { title: "Hello", date: "2026-10-14" }, body: "# Hello" }, { ifDigest: null })
await posts.list({ ref: "draft", filter: { tags: "vue" }, sort: { field: "date", direction: "desc" } })
await posts.status("hello") // { collection: "posts", id: "hello", state: "draft", draft: saved.digest, published: null }
await posts.raw("hello", { ref: "draft" }) // the stored file, even if it no longer validates
await content.publish({ expect: [{ collection: "posts", id: "hello", digest: saved.digest }] })
await content.revisions("posts", "hello")
content.collections() // [posts], each with name, kind, format, path, fields, and schema
```

`cms` comes from [`@vite-hub/cms`](https://www.npmjs.com/package/@vite-hub/cms), the CMS built on Content. It adds the Workspace that stores the collections, its Database tables, and, with `repo`, the GitHub store. Without it, pass `workspace`: the name of a Workspace with retained history. `defineContentPreset()` creates a preset for `defineContent({ extends })`; a preset fills Definition options at runtime only.

`await content.supportsScheduling()` reports whether the Workspace store supports scheduled publishing. It returns `false` for the GitHub store and does not check for a Schedule runner. The Console marks scheduling unavailable for GitHub Workspaces. With `scheduling: false` in its options, the Content Console section does not ask for a `content.publishDue()` runner; `vite-hub` sets it for the GitHub store of the CMS.

`documents({ label, titleField })` names a collection, such as `label: { singular: "Person", plural: "People" }`, and the string field that names a document. Without them the label is the name in title case, and the title field is the first of `title`, `name`, `label`, and `heading`, then the first required string field. `singleton()` takes a `label` string and `titleField` too.

`singleton({ path, fields })` defines one document at a fixed path, such as site settings. Its methods take no id, and `publish({ expect })` entries for it may omit `id`. The extension sets the format of a document or collection: `.json` stores an indented JSON object, `.yaml`/`.yml` a block-style YAML mapping, and anything else Markdown with YAML frontmatter. JSON and YAML documents have no body.

```ts
import { z } from "zod"
import { defineContent } from "@vite-hub/content"
import { documents, singleton } from "@vite-hub/content/collections"

const content = defineContent({
  workspace: "site",
  collections: {
    settings: singleton({ path: "settings.json", fields: { title: z.string(), social: z.array(z.url()).default([]) } }),
    authors: documents({ path: "authors/*.yaml", fields: { name: z.string() } }),
  },
})

export default content

const settings = content.collection("settings") // kind: "singleton", id: "settings"
const draft = await settings.save({ data: { title: "ViteHub" } })
await content.publish({ expect: [{ collection: "settings", digest: draft.digest }] })
await settings.get() // the published settings, also at /api/content/get/settings
```

`documents({ path: "docs/{locale}/**/*.md", locales: ["en", "es"] })` keeps a document in several locales. The first locale is the source locale, and a document keeps its id in every locale: `guide` is `docs/en/guide.md` and `docs/es/guide.md`. `get()`, `raw()`, and `list()` take `locale`; without a translation, `get()` and `list()` return the source locale version with `fallback: true`. `save()`, `remove()`, and `restore()` take `{ locale }`. `get()` returns `source: { path, digest }`, the source locale version in the `sha256-` lineage form. A save in another locale with `sourceDigest: source.digest` records `derivedFrom: { path, digest }` of the source version that was read, as `@vite-hub/workspace/lineage` reads it. Without `sourceDigest`, an existing translation keeps its `derivedFrom` and a new one records the source locale draft. `status()` gives each source locale document `translations`, such as `{ es: "stale" }`: `current`, `stale` when the source changed since or `derivedFrom` names another file than the source locale file of the same id, or `missing`. `publish()` publishes every locale, and `publish({ expect })` entries take `locale`. A `url` pattern without `:locale` puts `/<locale>` before the URL of every locale but the source locale.

```ts fragment
const docs = content.collection("docs")
const english = await docs.get("guide", { ref: "draft", locale: "es" }) // the fallback, with source: { path, digest }
await docs.save("guide", { data: { title: "Guía" }, body: "Hola." }, { locale: "es", sourceDigest: english.source.digest }) // records derivedFrom
await docs.get("intro", { locale: "es" }) // { locale: "en", fallback: true, ... } without a translation
await docs.status("guide") // { locale: "en", translations: { es: "current" }, ... }
```

Every save commits to the `draft` history ref; `publish()` copies selected documents to `published`. `/api/content/**` and the collection Comark instances serve `published`, except to a request with a valid preview cookie. Content registers a `write:validate` Workspace plugin, so every Workspace writer is validated on the collection paths: the `draft` ref accepts fields in progress, every other ref only valid documents. `save()` stores invalid fields and returns them as `issues`; `publish()` and `schedule()` refuse such drafts with `CONTENT_INVALID` naming each one. Saves of different documents retry over each other; `ifDigest` rejects a save when the same document changed. `publish({ expect })` publishes exactly the reviewed draft digests and throws `WORKSPACE_CONFLICT` when one changed, so confirm and approve flows use it. Listed documents carry `updatedAt`, when each last changed on the ref read. The runtime methods are trusted server API; surfaces such as the Console and Agent Capability check `content.can({ user, actor })` first, where `user` is the Auth user and `actor` is the Agent Actor, if any. Zod date fields project to `date-time` strings in `schema`; wrap Valibot fields in `toStandardJsonSchema()`, and Content warns once for each field whose JSON Schema is empty.

## Draft preview

`content.preview.enable(event)` signs an HMAC token with `VITEHUB_CONTENT_KEY` (32 random bytes as base64 or hex) and sets it as an `HttpOnly`, `SameSite=Strict` cookie for one hour by default. A request with a valid cookie reads `draft` through `/api/content/**`, `content.get()`/`list()`/`navigation()`/`search()`, and collection `get()`/`list()`, and gets `Cache-Control: private, no-store`. The grant lives in `AsyncLocalStorage` for that request only.

```ts
// server/api/preview.post.ts
import { withAuth } from "@vite-hub/auth/server"
import type { H3Event } from "h3"
import { createError, defineEventHandler } from "h3"
import content from "../content"

export default defineEventHandler(withAuth(async (event: H3Event, { user }) => {
  if (!await content.can({ user, collection: "posts", action: "read" })) throw createError({ statusCode: 403 })
  return await content.preview.enable(event, { maxAge: 900 }) // content.preview.disable(event) clears it
}))
```

Outside Nitro, such as in a test, run a read in preview yourself: `await content.preview.run(event, () => content.collection("posts").get("hello"))`.

ViteHub generates a `defineContentPreviewPlugin()` Nitro plugin for Nitro 3 and Nuxt 5 apps. It imports `@vite-hub/content/preview` and loads `server/content.ts` on the first request with a preview cookie, a preview frame, or `?vitehub-content-published`, so the server starts without the Content runtime. It wraps Nitro's request entry, so pages and server routes read drafts without changes, and Nitro's cached handlers, `cache`/`swr` route rules, and cached functions skip preview requests. Without the key, preview works only when `NODE_ENV` is `development` or `test`; elsewhere `enable()` throws `CONTENT_R0010` and cookies are ignored.

The same plugin serves preview frames, for an editor that shows one document in a frame. The page preview of the Console that the app served used them, and is removed. A frame posts a form to the page URL with `?vitehub-content-preview` (`contentPreviewFrameParameter`), whose field of the same name holds `{ token, document? }` as JSON. `content.preview.sign({ collection, id })` returns a token for that one document, without a cookie; check `content.can()` with `read` first. The page runs as a `GET` of its own URL. Collection `get()`/`list()` without `ref` or `revision` return the posted version of the signed document, or its stored draft, so edits that were not saved render through the real routes. Every other read, other documents and collections included, is `published`. Nothing is stored. A form without a valid frame token, with another document, or from another site, gets 403. A frame token never works as the preview cookie. A redirect of the page to the same origin becomes a `307` with `?vitehub-content-preview=<hop>`, so the browser posts the same form there and selects and sets cookies itself; a redirect to another origin or past five gets an error page with `<meta name="vitehub-content-preview-error">` (`contentPreviewErrorName`). A request with `?vitehub-content-published` (`contentPreviewPublishedParameter`), or a same-origin `Referer` with it, reads `published` with or without a preview cookie, nested runs included, and leaves the cookie unchanged. An HTTP redirect from such a request to the same host name gets the parameter in its `Location`, so the destination reads `published` too.

The `content()` Agent Capability from `@vite-hub/agent/capabilities` gives an Agent tools to list, read, save drafts, publish, and schedule collections and singletons, typed by each collection's fields. It checks `content.can()` with the Invocation's Actor and the Auth user it stands for, for each document it shows or changes. Publishing, scheduling, and cancelling a schedule require approval by default and use exactly the draft digests in the call. Saves honor edit leases unless the Capability sets `lease: "override"`.

`content.sessions` keeps presence and edit leases in the Database of the Workspace history: `report()` every 15 seconds, `acquire()` on the first edit, `release()` when the editor closes, and `list()` for list rows. While one session holds a document's lease, `save()`, `remove()`, and `restore()` from other callers throw `CONTENT_LEASE_HELD`; pass `{ session }` from the holder's tab, or `{ lease: "override" }`. Add `contentSessionsSchema` from `@vite-hub/content/database` next to `workspaceHistorySchema`. `documents({ editing: { lease: false } })` keeps presence without the lease.

With Realtime enabled on a host with a room authority, ViteHub contributes a `content` Realtime Definition from `contentRealtime(content)` in `@vite-hub/content/realtime`: several people edit one Markdown document at once, the room saves into `draft` with `ifDigest`, and it holds the edit lease as `kind: 'live'`. `contentRealtimeEditor()` in `@vite-hub/content/editor` adapts Comark UI's shared editor codec to the room. The live editor of the Console that the app served is removed; build your own on this room. The Console uses `createContentEditorCodec()` from that same entry, with the same schema and loss check; unknown components, slots, task lists, and media survive an edit. `defineContent({ live: false })` keeps one editor at a time.

## SEO

`content.schedule({ at, expect })` publishes exactly the reviewed draft digests at a later time. A Schedule Definition such as `defineSchedule({ cron: "* * * * *", handler: () => content.publishDue() })` runs due schedules on every Schedule host. A draft saved after scheduling makes the run publish nothing and the schedule `failed`, with the `WORKSPACE_CONFLICT` details, until `unschedule(id)` dismisses it. `content.schedules()` lists pending, overdue (more than five minutes late without a run), and failed schedules, and `status()` reports each document's `schedule`. Schedules are JSON files on the `schedules` ref of the Content Workspace, so every change is a revision.

`documents({ url: "/blog/:id" })` maps documents to public URLs, and reads carry `document.url`. `content.resolve("/blog/hello")` maps a page back to its `{ collection, id }` with the same `url`, for an Edit button; a collection without `url` resolves the id after a slash, without a trailing `/index`. `seo()` is a field for per-document `{ title, description, image, canonical, noindex }`; pass `seo({ image: image() })` to store a Blob reference. `contentHead(document, { collection, site, defaults })`, also exported from `@vite-hub/content/client`, returns unhead-shaped `{ title, meta, link, script? }` that merge the `seo()` values, the document fields, and site defaults. It finds the `seo()` field of `collection` by its marker, and resolves Blob images with the served route of the generated Blob config. `defineContent({ seo: { site, sitemap: true, robots: true } })` makes ViteHub generate `/sitemap.xml` and `/robots.txt`; `content.sitemap()` and `content.robots()` return the same output. `seo: { markdown: true }` also serves each published Markdown document at its URL plus `.md`, such as `/blog/hello.md` for `/blog/hello` and `/index.md` for `/`. The copy starts with the document's title, unless the body has its own heading, and its description as a quote, and turns root-relative links into absolute ones. Agents read it, and readers paste it into a chat. `content.markdown("/blog/hello.md")` returns the same text, or null. The sitemap also lists the documents of Sources with `contentSource(input, { url })`, without `lastmod`. Markdown copies read `collections` only. The page URL also returns the copy for `Accept: text/markdown`, with `Vary: Accept`, and a Markdown request that no page answers gets a Markdown 404 body. `seo: { llms: true }`, or `{ title, description }`, serves `/llms.txt`, `/llms-full.txt`, and `/sitemap.md` from the same pages as the sitemap, Markdown collections only, and turns on `markdown` because their links point at the `.md` copies. `content.llms({ file })` returns the same text. The formats match `@vite-hub/docs`.

```ts fragment
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
vitehub content delete <collection> [id] [--yes] [--override-lease]
vitehub content restore <collection> [id] --revision <id> [--override-lease]
vitehub content publish [--collection <name>] [--id <id>...] [--dry-run] [--yes]
vitehub content schedule --at <time> [--collection <name>] [--id <id>...] [--dry-run] [--yes]
vitehub content scheduled [collection] [id] [--status pending|overdue|failed]
vitehub content unschedule <schedule>
vitehub content sitemap [--site <url>] [--xml]
```

Omit the id for a singleton. `edit` saves drafts with field issues and prints them; it honours edit leases unless `--override-lease`. `rm` deletes a draft after confirmation, and `restore` saves an earlier version as the draft; both pin the draft that they read and honour edit leases. `publish` and `schedule` pin the draft digests they list and refuse drafts with field issues. Every command accepts `--json`. Each command runs a `content.*` operation through the app's `POST /_vitehub/rpc` route. Without `--url` it calls the dev server; with `--url` it calls a deployed app that enables the Console, and signs each call with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. The operations call `content.can()` with the user of the call: the person that the Console signed, or no user for the CLI.

## ViteHub MCP

With the Console enabled, an agent on the ViteHub MCP of the Console lists readable collections and documents, reads drafts, and saves drafts through the same Content operations as the editor. Each call checks `content.can()` with the Console user. Saves require `ifDigest` and respect edit leases. The application module loads on the first call. See [ViteHub MCP](https://vitehub.dev/docs/development/mcp).
