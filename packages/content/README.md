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

`content.searchSections(names?, { headings, ignore })` returns every document
split by heading, for a search that ranks in the browser or in another index.
It needs no database, so it works on every host. Each part has `id` (the
document path, plus `#<heading id>`), `title`, `titles` (the headings above it),
`level`, `content`, and its document's `source` and `key`. `headings` defaults
to `[2, 3]`, and headings inside components count. `ignore` lists tags whose
text search skips. `contentSearchSections(document, options)` splits one parsed
document the same way.

Use `contentSource(input, { prefix, schema, url, label, seo, markdown })` to configure a Source. `url`, such as `"/:id"`, lists the Source's documents in the sitemap; the id is the document path without its leading slash. `label` names the Source's `llms.txt` section. `seo({ id, data })` returns `{ title, description, noindex, canonical }` for frontmatter that does not use the `seo` field. `markdown(page)` renders the Markdown copy of a page from its whole file, as a string or `{ markdown, footer }`; only the `.md` copy ends with `footer`. Adapted Sources retain one reader per asynchronous load, including overlapping refreshes. `defineContentHandler()` serves the Comark Web handler as a Fetchable route, `{ fetch(request) }`. `defineContentSitemapHandler()`, `defineContentRobotsHandler()`, and `defineContentLlmsHandler()` return Fetchable routes too. `defineContentMarkdownHandler()` is H3 middleware, because it returns nothing to pass other requests on. It takes the Content runtime or a function that loads it; with a function, it loads Content for Markdown requests and to check whether downstream responses have copies. `@vite-hub/content/markdown` exports it without the Content runtime, for the generated middleware that loads when the server starts.

Every reader of published Content asks `defineContent({ authorize })` with `{ user, action: "read" }` for each request: `/api/content/**`, `/sitemap.xml`, `/rss.xml`, `/llms.txt`, `/llms-full.txt`, `/sitemap.md`, Markdown copies, `/mcp`, and preview URLs. `/robots.txt` names no page and stays public. A preview URL that a Console preview cookie or a signed link opened does not ask. `user` is the ViteHub Auth session user when the app has Auth, else null. A denied request gets 401 without a user and 403 with one. An answer that `authorize` decided gets `Cache-Control: private, no-store`. Without a policy, the readers serve everyone. A `github()` Source can read a private repository with a token, so `defineContent()` throws `CONTENT_R0006` for one when a reader would serve it without a policy, until you set `authorize` or `access: "public"`, or turn those readers off. `access: "public"` serves every reader to everyone without asking `authorize` for `read`; `authorize` still decides writes and publishing. `route: false` disables `/api/content/**`; server reads, Console editing, draft preview, and configured SEO routes remain available. In another server, pass the user to each reader, such as `defineContentHandler(content, { user: request => ... })`, `defineContentLlmsHandler(content, { user })`, `defineContentMarkdownHandler(load, { user })`, `defineContentMcpHandler(content, { user })`, and `defineContentPreviewRoutesPlugin(load, { user })`.
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
await content.sources.head("docs") // { source: "docs", live: true, sha, ref: "main", movedAt, pinned: false, rejected: null, checkedAt, webhook, diagnostic: null, cache, views }
await content.sources.advance("docs") // move to the latest commit of main when every document parses
await content.sources.pin(sha, "docs") // serve this commit until unpin(), for example to roll back
await content.sources.unpin("docs")
```

- The first read resolves the branch, validates the commit, and stores the head when KV has none. A live Source without an accepted commit fails reads; `head()` still shows its rejection. After fixing a document or a temporary retrieval failure, call `advance()` to retry, including for the same SHA.
- `advance()` loads and parses every document of the latest commit, then runs the error rules of [`content.check()`](#check-documents): frontmatter against the Source `schema`, and links to missing pages. The head moves only when the commit has no error. Warnings, such as a short title, do not hold it back. Otherwise the head stays on the last valid commit, `rejected` names the commit and the first errors, and Content logs `CONTENT_R0019`. A push with a broken document or link never reaches readers. The GitHub push webhook below calls `advance()` for you.
- Send first initialization and all `advance()`, `pin()`, and `unpin()` calls for each Source through one serialized writer. Initialize the head before starting read replicas. KV has no atomic conditional write: concurrent writers are unsupported and can overwrite a pin or a newer head.
- A pinned head does not move until `unpin()` within that writer contract. `pin()` takes a full 40-character commit SHA and validates it too.
- Each server instance holds the head in memory for 5 seconds. Read replicas check KV again after 5 seconds; provider consistency can delay visibility further. All Source reads, including SQL queries, sitemap, explicit initialization, and type generation, follow the selected head. GitHub Sources keep their parsed cache in memory per instance; they do not restore the shared `cache.driver`, which has no commit identity.
- Without a token, the Source is not live: each load reads the latest commit of its branch without validation, and Content logs `CONTENT_R0020` once. The token is `github({ auth })`, or the Server Env `VITEHUB_GITHUB_TOKEN`.
- ViteHub turns KV on when `server/content.ts` imports `github()` and `vitehub()` leaves `kv` unset. You do not add KV yourself. The head uses the `default` KV store. On Cloudflare, it is the KV namespace bound as `KV`. `vitehub kv get content:head:docs` shows the stored head.
- Without a KV store, such as with `kv: false` or when `server/content.ts` gets its Sources from another file, the Source is not live: it reads its branch as without a token, and Content logs `CONTENT_R0021` once.
- When the KV store fails on a read, the page does not fail. Content logs `CONTENT_R0022`, serves the commit that the server instance already serves, or else the latest commit of the branch, and tries KV again after 5 seconds. `head()`, `advance()`, `pin()`, and `unpin()` throw `CONTENT_R0022` to the caller.
- When GitHub answers 403 or 429 to the branch lookup, as it does when the rate limit is hit, the head stays where it is. Content logs `CONTENT_R0035` once, and `head()` on that server instance returns it in `diagnostic` until a lookup succeeds.
- `diagnostic` is `{ code, message, fix }` when the head does not follow the branch: `CONTENT_R0020`, `CONTENT_R0021`, `CONTENT_R0035`, or `CONTENT_R0019`. `vitehub content head` prints it.
- Without a push webhook, the head still moves: the first read one hour after the last check resolves the branch again and calls `advance()`. That read waits for the check. It takes a one-minute lease under `content:check:<source>` first, so other server instances do not check at the same time. Completed checks store `checkedAt` under `content:checked:<source>`. An unchanged branch needs no head write unless a stored rejection becomes history; a changed branch needs one. A failed check is tried again after the lease.

### Check documents

`content.check()` checks the documents of the Sources with no built HTML and no network. A `github()` Source is checked at `sha`, or at the latest commit of its branch, and its head does not move.

```ts fragment
const result = await content.check({ source: "docs", sha })
// { ok: false, errors: 1, warnings: 2, sources: [{ source: "docs", sha, pages: 357 }], findings: [{ source, path: "guide.md", url: "/guide", line: 12, rule: "link", code: "CONTENT_R0062", severity: "error", message }] }
```

| Rule | Code | Severity | Finds |
| --- | --- | --- | --- |
| `parse` | `CONTENT_R0060` | error | A document that does not load or parse. |
| `frontmatter` | `CONTENT_R0061` | error | Frontmatter that does not match `contentSource(input, { schema })`. |
| `link` | `CONTENT_R0062` | error | A link to a missing page below a first path segment that holds pages, such as `/docs/kvv` next to `/docs/kv`. |
| `route` | `CONTENT_R0063` | warning | A link to a path that no page serves, such as `/learn`. Another route of the app may serve it. |
| `anchor` | `CONTENT_R0064` | warning | A link to a heading id that the target page does not have. |
| `title` | `CONTENT_R0065` | warning | No title, or a title outside 10 to 60 characters. |
| `description` | `CONTENT_R0066` | warning | No description, or one outside 70 to 160 characters. |
| `duplicate` | `CONTENT_R0067` | warning | Pages with the same title or description. |
| `heading-order` | `CONTENT_R0068` | warning | A heading that skips a level. The page title counts as the `h1`. |

The search rules and limits are those of the `@vite-hub/docs` `seoAudit`, and they skip pages with `seo.noindex`, `seo.index: false`, or a canonical URL to another page. A page is a Markdown document; its URL comes from the `url` of the Source, else its path. Links resolve in memory against the checked commits and pages from other configured Sources. A head change or a check of one Source uses the published heads of the other Sources, or their branch commits when no head exists. The checked Source never uses pages from its previous head. Links to other origins are not checked. `defineContent({ check })` sets the options:

```ts fragment
defineContent({
  sources: { docs: contentSource(github({ repo: "acme/docs", dir: "content" }), { url: "/:id" }) },
  check: {
    ignoreLinks: ["/learn", "/docs/*/diagnostics/**"], // paths, globs, or RegExps that other routes serve
    titleTemplate: "%s · Acme", // the title rule measures the title as the <title> shows it
  },
  seo: { site: "https://acme.dev" }, // absolute links to this origin are checked too; `check.site` overrides it
})
```

`CONTENT_R0069` means the check could not run, such as for an unknown Source, a `sha` that is not a full commit SHA, or a commit that GitHub does not give. `vitehub content check` prints the same result.

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

- A read tries memory first, then the build snapshot, then KV, then the GitHub archive. Validation and serving share one download: the first read of a commit downloads one archive, and a server instance with the commit in KV downloads none.
- When the build has a GitHub token, such as `VITEHUB_GITHUB_TOKEN`, it resolves the branch of each `github()` Source, parses that commit, and ships it with the server, gzipped. While the head is that commit, a cold server reads it from the bundle and downloads nothing, even with an empty KV. The server inflates it on the first read that needs it, not at start, and only when the head is the build commit. When the head moved, the commit cache works as before. Without a token at build, the build ships no commit. A build commit that does not parse ships nothing, and the build warns.
- `parserHash` hashes the Comark options, plugin source text, the Source fingerprint, its effective `prefix` and `schema`, and the build. Each build uses new keys.
- The built-in parser reuses parsed documents from KV. With custom `markdown.plugins` or Content `plugins`, each new runtime parses the cached files again without a download. Function source text cannot identify captured plugin options or implementations. Within one runtime, memory holds the parsed result.
- Content writes an artifact only after every document parses. A rollback with `pin()` to a valid commit reads it from the cache. A rejected load or failed download stays out of memory, so `advance()` can retry it.
- Each server instance holds the last 4 commits in memory.
- `head().cache` shows the key of the served commit, the reads from memory, from the build snapshot (`build`), and from KV, and the misses. Each miss is one archive download. `vitehub kv get <key>` shows the stored commit. When KV refuses a value, for example one larger than 25 MiB on Cloudflare, Content logs `CONTENT_R0023` and other server instances download the commit again.

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
- `at()` does not check access, and serves no route by itself: `previews: true` adds the routes, with `allow()` first. Draft branches, such as the CMS `vitehub/content` branch, and fork pull requests can hold content that is not public. Call `content.sources.allow()` first.

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

### Preview URLs

Set `previews: true` and Content serves each ref that `allow()` lets through at a URL. Nitro, Nuxt (through `vite-hub/nuxt`), and Vite apps get the URLs from this one option. ViteHub generates a Nitro plugin for it, so you write no route.

```ts
// server/content.ts
import { defineContent } from "@vite-hub/content"
import { github } from "@vite-hub/source"

export default defineContent({
  sources: { docs: github({ repo: "acme/docs", ref: "main" }) },
  previews: true,
})
```

| URL | Reads |
| --- | --- |
| `/tree/<branch>/-/<path>` | The latest commit of a branch. The branch can contain `/`, such as `/tree/feat/x/-/docs/kv`. The part `-` ends the branch name. `/tree/<branch>` alone is the root page. |
| `/blob/<sha>/<path>` | One commit, by its full 40-character SHA. |
| `/pr/<number>/<path>` | The head commit of a pull request. |

- The page runs with its production path, such as `/docs/kv`, through the route rules, middleware, and routes of the app. Every read of the `github()` Source in that request, `content.get()`, `list()`, `navigation()`, `search()`, `manifest()`, `stat()`, `query()`, `from()`, `getSource()`, `media`, `instances`, custom plugin methods, and `/api/content` included, returns the commit of the ref. The request keeps the host fields that Nitro and srvx put on it, such as `runtime`, `context`, `ip`, and `waitUntil`. Collections and other Sources read as usual.
- `content.get()` and `/api/content` put the internal links of the Comark tree under the prefix: `/docs/next` becomes `/pr/12/docs/next`. Links to other sites, `//host` links, and `#anchors` stay as they are. Links that the app writes itself do not change. Put `content.sources.current()?.prefix` before them.
- `content.sources.current()` returns `{ source, ref, kind, sha, pull, route, prefix, path, url }` in a preview request and null in other requests. `url` is the production URL of the page, from `seo.site` or the request origin. Use it for a preview bar, such as "Viewing PR #12", with a link to production.
- A ref that `allow()` denies, an invalid ref, and a ref that GitHub does not have all reach the app with the URL as it came, so the app answers with its own 404, as for any unknown path. A response does not tell a private ref from a missing one. Content logs `CONTENT_R0031` once per ref.
- A preview response has `X-Robots-Tag: noindex`, a `Link: <production URL>; rel="canonical"` header, and a `Cache-Control` for the ref: `private, no-store` with the preview cookie or a `?vitehub-content-token` link, `public, max-age=31536000, immutable` for a `/blob` commit in the published history, and `public, max-age=60` for the other refs. These are upper bounds: application `max-age` and `s-maxage` values can shorten them, and application revalidation directives stay in place. An application response with its own cache policy does not become immutable only because the Source commit is published. A response that the app marks `private`, `no-store`, or `no-cache`, or that sets a cookie, stays private. A same-site redirect stays under the prefix. A ref that a signed link opened keeps `?vitehub-content-token` on its internal links and redirects, so the reader can follow them without the preview cookie. Nitro's cache is bypassed in a preview request, so a cached route never mixes refs.
- With more than one `github()` Source, name the one to preview: `previews: { source: "docs" }`. Without a `github()` Source, or with a name that is not one, a preview URL fails with `CONTENT_R0045`.
- An encoded `/`, a dot part such as `%2e%2e`, and a ref that `at()` does not accept never reach the app as a preview, so the page path cannot leave the prefix. A SHA opens only as `/blob/<sha>`, and a pull request only as `/pr/<number>`, so each commit view has one URL shape.
- The server renders the page at its production path, and the browser keeps the preview URL. In Nuxt, the client router does not know the prefix yet, so a page that reads its route on the client, such as a `useAsyncData()` key from `useRoute().path`, sees the preview URL after hydration.
- `content.sources.previewLinks(number, { site?, maxAge? })` returns the preview links of a pull request: `{ source, repo, sha, pull, access, expiresAt, pages }`, where each page is `{ key, path, url }` for a file of the pull request that is a page of the Source. It reads the GitHub file list of the pull request, and leaves out removed files and files that are not pages. `access` is what `allow()` decides for a reader without a cookie: `pull`, `label`, or `published` give plain links; for a private pull request, such as a CMS publish, it is `token` and each link has a token from `sign()`, valid for `maxAge` seconds (one hour by default, 24 hours at most). `fork`, `closed`, and `unpublished` links are never signed and answer 404 until the rule changes. `url` is absolute with `site` or `seo.site`, else a path. It throws `CONTENT_R0079` without `previews` and `CONTENT_R0075` when GitHub has no such pull request. This is trusted server API, like `sign()`.
- With `previews` on, a CMS `publish()` that opens a pull request returns `previews`: `[{ collection, id, locale?, url, expiresAt }]`, a signed `/pr/<number>/<url>` link for each published document with a `url`, valid for one hour. The link shows the pull request when the page reads the `github()` Source of `previews`, as when the CMS edits the files of the docs repository. Collections still read `published` in a preview request. When Content cannot sign, the pull request still opens, `previews` is missing, and Content logs `CONTENT_R0076`. The Console offers "Open preview" after such a publish when it can open the link.
- Revisions of the Blob + Database store do not open at `/blob/<id>`. Their ids are not Git commits, and `/blob` reads a commit of the `github()` Source after `allow()` checks it on GitHub. Draft preview and preview frames show those revisions.
- The prefixes sit at the root of the host. `parseContentPreviewPath(pathname)` reads a URL the same way. In another server, add `defineContentPreviewRoutesPlugin(content)` from `vite-hub/content/preview` first in the Nitro 3 plugin list, before async plugins, or call `content.sources.route(request, next)` yourself.

## Page history

`content.history(path)` lists the published changes of the page at an app path, newest first. Collection documents and `github()` Source pages return one shape, so "last updated", RSS, and a history panel read one API.

```ts fragment
const history = await content.history("/docs/guide", { limit: 20 })
// { entries: [{ id, at, author, message, url }], cursor } or null when no page has that path
const lastUpdated = history?.entries[0]?.at
const next = await content.history("/docs/guide", { limit: 20, cursor: history?.cursor })
```

- The result is public history only, so a public page can show it. A collection document lists its `published` revisions and never its drafts, also with a cursor: a GitHub Workspace refuses a cursor whose commit is not on the published branch. A singleton with a `url` has history too. A locale page without a translation lists the history of the source locale version that it shows. `author` is the `author` of the revision metadata, as a string or `{ name }`. `url` is the commit page when the Workspace stores history on GitHub, else null.
- A `github()` Source page lists the commits that changed its file, up to the commit that readers get: the head of `content.sources`, or the latest commit of the branch when the Source is not live. A push that the head has not reached stays out. `author` is the GitHub login, else the Git author name. `message` is the first line of the commit message.
- GitHub commits for a file do not follow renames, so the history of a moved page starts at the move.
- Content reads GitHub 100 commits at a time and caches each page per head commit and file, in memory and in the `default` KV store under `content:history:<source>:<origin>:<sha>:<key>:<page>`, where `<origin>` is a hash of the Source options, so another `root` gets other keys. History at a commit never changes, so the cache never expires. A second call, also from another server instance, sends no commits request. A Source that is not live resolves its branch on each call, which costs one request. When KV fails, Content reads GitHub.
- Without a GitHub token, a `github()` Source page returns `{ entries: [] }` and Content logs `CONTENT_R0040` once per Source. Other Sources, such as `glob()`, return no entries.
- `limit` is 1 to 100, default 20. Pass the `cursor` of the previous call to read older entries.

## Types

In development, ViteHub writes `.vitehub/types/content.d.ts` with Comark's type generation. It types the `data` of `content.get()`, `content.list()`, and `content.query()` from the schema of each Source and collection: a collection uses its fields, and Comark infers a Source's schema from its documents. The generated `.vitehub/content/types.mjs` Nitro plugin sends declarations to the host process, which writes the file in the background when the server starts and after Content changes. A production build drops it. `generateContentTypes(content, { moduleName })` returns the same declarations. They extend Comark's `ContentRegistry` and `ContentPathsRegistry` through `@vite-hub/content`, or through `moduleName`, because an app that installs only ViteHub cannot resolve `comark-content` itself.

## Markdown rendering

Content parses Markdown with the [Comark UI](https://comark-ui.onmax.me) preset, excluding the HTML-only `annotate`, `diff`, and `quiz` plugins that have no Vue renderers. Callouts, steps, tabs, cards, badges, diagrams, and tables use its parsers. `markdown.plugins` adds plugins; a plugin with a preset plugin's name replaces it. `markdown: { preset: false, plugins }` parses with your plugins alone, as `@vite-hub/docs` does with `docsMarkdown()`. Content plugins still go in `plugins`. HTML-only blocks need an explicit parser plugin and application component override.

Render a page with ViteHub UI. Its `Markdown` primitive accepts both a parsed Content page and a Markdown string, with Comark UI components and document styles already configured:

```vue
<script setup lang="ts">
import { Markdown } from "@vite-hub/ui"

const { data: page } = await useFetch("/api/content/get/docs/introduction")
</script>

<template>
  <Markdown v-if="page" :value="page" />
</template>
```

With the framework distribution, import from `vite-hub/ui`. There is no separate Comark UI install, component map, or stylesheet to configure. Pass `components` only to override a renderer for your application.

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
  if (!await content.can({ user, collection: "posts", action: "read-draft" })) throw createError({ statusCode: 403 })
  return await content.preview.enable(event, { maxAge: 900 }) // content.preview.disable(event) clears it
}))
```

Outside Nitro, such as in a test, run a read in preview yourself: `await content.preview.run(event, () => content.collection("posts").get("hello"))`.

ViteHub generates a `defineContentPreviewPlugin()` Nitro plugin for Nitro 3 and Nuxt 5 apps. It imports `@vite-hub/content/preview` and loads `server/content.ts` on the first request with a preview cookie, a preview frame, or `?vitehub-content-published`, so the server starts without the Content runtime. It wraps Nitro's request entry, so pages and server routes read drafts without changes, and Nitro's cached handlers, `cache`/`swr` route rules, and cached functions skip preview requests. Without the key, preview works only when `NODE_ENV` is `development` or `test`; elsewhere `enable()` throws `CONTENT_R0010` and cookies are ignored.

The same plugin serves preview frames, for an editor that shows one document in a frame. The page preview of the Console that the app served used them, and is removed. A frame posts a form to the page URL with `?vitehub-content-preview` (`contentPreviewFrameParameter`), whose field of the same name holds `{ token, document? }` as JSON. `content.preview.sign({ collection, id })` returns a token for that one document, without a cookie; check `content.can()` with `read-draft` first. The page runs as a `GET` of its own URL. Collection `get()`/`list()` without `ref` or `revision` return the posted version of the signed document, or its stored draft, so edits that were not saved render through the real routes. Every other read, other documents and collections included, is `published`. Nothing is stored. A form without a valid frame token, with another document, or from another site, gets 403. A frame token never works as the preview cookie. A redirect of the page to the same origin becomes a `307` with `?vitehub-content-preview=<hop>`, so the browser posts the same form there and selects and sets cookies itself; a redirect to another origin or past five gets an error page with `<meta name="vitehub-content-preview-error">` (`contentPreviewErrorName`). A request with `?vitehub-content-published` (`contentPreviewPublishedParameter`), or a same-origin `Referer` with it, reads `published` with or without a preview cookie, nested runs included, and leaves the cookie unchanged. An HTTP redirect from such a request to the same host name gets the parameter in its `Location`, so the destination reads `published` too.

The `content()` Agent Capability from `@vite-hub/agent/capabilities` gives an Agent tools to list, read, save drafts, publish, and schedule collections and singletons, typed by each collection's fields. It checks `content.can()` with the Invocation's Actor and the Auth user it stands for, for each document it shows or changes. Publishing, scheduling, and cancelling a schedule require approval by default and use exactly the draft digests in the call. Saves honor edit leases unless the Capability sets `lease: "override"`.

`content.sessions` keeps presence and edit leases in the Database of the Workspace history: `report()` every 15 seconds, `acquire()` on the first edit, `release()` when the editor closes, and `list()` for list rows. While one session holds a document's lease, `save()`, `remove()`, and `restore()` from other callers throw `CONTENT_LEASE_HELD`; pass `{ session }` from the holder's tab, or `{ lease: "override" }`. Add `contentSessionsSchema` from `@vite-hub/content/database` next to `workspaceHistorySchema`. `documents({ editing: { lease: false } })` keeps presence without the lease.

With Realtime enabled on a host with a room authority, ViteHub contributes a `content` Realtime Definition from `contentRealtime(content)` in `@vite-hub/content/realtime`: several people edit one Markdown document at once, the room saves into `draft` with `ifDigest`, and it holds the edit lease as `kind: 'live'`. `contentRealtimeEditor()` in `@vite-hub/content/editor` adapts Comark UI's shared editor codec to the room. The live editor of the Console that the app served is removed; build your own on this room. The Console uses `createContentEditorCodec()` from that same entry, with the same schema and loss check; unknown components, slots, task lists, and media survive an edit. `defineContent({ live: false })` keeps one editor at a time.

## SEO

`content.schedule({ at, expect })` publishes exactly the reviewed draft digests at a later time. A Schedule Definition such as `defineSchedule({ cron: "* * * * *", handler: () => content.publishDue() })` runs due schedules on every Schedule host. A draft saved after scheduling makes the run publish nothing and the schedule `failed`, with the `WORKSPACE_CONFLICT` details, until `unschedule(id)` dismisses it. `content.schedules()` lists pending, overdue (more than five minutes late without a run), and failed schedules, and `status()` reports each document's `schedule`. Schedules are JSON files on the `schedules` ref of the Content Workspace, so every change is a revision.

`documents({ url: "/blog/:id" })` maps documents to public URLs, and reads carry `document.url`. `content.resolve("/blog/hello")` maps a page back to its `{ collection, id }` with the same `url`, for an Edit button; a collection without `url` resolves the id after a slash, without a trailing `/index`. `seo()` is a field for per-document `{ title, description, image, canonical, noindex }`; pass `seo({ image: image() })` to store a Blob reference. `contentHead(document, { collection, site, defaults })`, also exported from `@vite-hub/content/client`, returns unhead-shaped `{ title, meta, link, script? }` that merge the `seo()` values, the document fields, and site defaults. It finds the `seo()` field of `collection` by its marker, and resolves Blob images with the served route of the generated Blob config. `defineContent({ seo: { site, sitemap: true, robots: true } })` makes ViteHub generate `/sitemap.xml` and `/robots.txt`; `content.sitemap()` and `content.robots()` return the same output. `seo: { markdown: true }` also serves each published Markdown document at its URL plus `.md`, such as `/blog/hello.md` for `/blog/hello` and `/index.md` for `/`. The copy starts with the document's title, unless the body has its own heading, and its description as a quote, and turns root-relative links into absolute ones. Agents read it, and readers paste it into a chat. `content.markdown("/blog/hello.md")` returns the same text, or null. The sitemap also lists the documents of Sources with `contentSource(input, { url })`; a `github()` Source page gets `lastmod` from its latest commit when a GitHub token is set. `seo: { rss: true }`, or `{ title, description, limit }`, serves `/rss.xml`: an RSS 2.0 feed of the Markdown pages that the sitemap lists, newest first by the date of their latest `content.history()` entry, 20 by default. The dates are cached per head commit in memory and ViteHub KV. The first read after a push asks GitHub for the pages that changed: one compare request and one GraphQL request per 150 changed pages. With no earlier dates, it asks for every page, so 2,600 pages cost 18 GraphQL requests, under the 50 subrequests of a free Cloudflare Worker. When the host has `waitUntil`, the generated routes do not wait for this: until the new dates are ready, they answer with the dates of the previous head and `Cache-Control: no-store`, and compute the new dates after the response. Blocking reads, background reads, and webhook warming share in-flight work within one Content instance. For several server instances, set `seo.dateLeases` to the same shared atomic `LeaseStore`, such as `createSqlLeaseStore()` from `@vite-hub/runtime`. It holds each Source/head for 60 seconds, including cache propagation time after success; a failure releases it for retry. A follower serves cached dates until it can see the new set, also without `waitUntil`. Cloudflare KV cannot lock a refresh. Without `dateLeases`, each instance can compute the same dates; use one refresh instance when shared leases are not available. A push webhook that moves the head computes them right away. Pass `{ waitUntil }` to `content.sitemap()` or `content.rss()` for the same behavior; without it they wait. Without a token, a Source page uses its `date` field, else it has no `pubDate` and goes last. `content.rss()` returns the same XML, and `contentHead(document, { rss: true })` adds the `alternate` link. Markdown copies and the llms files read Markdown collections and the Markdown files of Sources with a `url`; a `noindex` page keeps its copy. `seo: { markdown: { prefix: "/raw" } }` also serves each copy below `/raw`, and the llms files link there. `seo.llms` takes `details`, text under the description, and `sections`, more sections of links. A `site` with a path, such as `https://example.com/docs`, keeps the path in every URL. `seo: { mcp: true }`, or `{ name }`, serves a public read-only MCP server at `/mcp` with the tools of the `@vite-hub/docs` MCP server: `list-pages` returns `[{ title, path, description, url }]` for the Markdown pages that the sitemap lists, at most 1,000 per call with `offset` for more, and `get-page` returns `{ title, path, description, content, url }` with the Markdown copy of one page in `content`, cut after 200,000 characters. It reads published collection documents and the files of the head commit of a `github()` Source, without frontmatter. `list-pages` leaves out `noindex` pages, but `get-page` reads them by path, as their `.md` copy does. An unknown or draft page is the tool error `[404] No page at <path>`. `content.pages()` and `content.page(path)` return the same data, and throw `CONTENT_R0070` for an invalid argument. In another server, mount `defineContentMcpHandler(content)`. The page URL also returns the copy for `Accept: text/markdown`, with `Vary: Accept`, and a Markdown request that no page answers gets a Markdown 404 body. An HTML page with a copy gets `Vary: Accept` and `Link: <url.md>; rel="alternate"; type="text/markdown"`; Every response at a URL with a copy varies on `Accept`, including JSON, assets, and redirects; URLs without copies keep their headers unless they return a 404. A copy has `Content-Location` and an `ETag`, so `If-None-Match` gets a `304`. `content.hasMarkdown(path)` checks for a copy without rendering it, and `contentHead(document, { markdown: true })` adds the `alternate` link tag. `seo: { llms: true }`, or `{ title, description }`, serves `/llms.txt`, `/llms-full.txt`, and `/sitemap.md` from the same pages as the sitemap, and turns on `markdown` because their links point at the `.md` copies. `content.llms({ file })` returns the same text. The formats match `@vite-hub/docs`.

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
vitehub content previews comment --pr <number> [--post] [--site <url>] [--max-age <seconds>]
vitehub content head [source]
vitehub content advance [source]
vitehub content pin <sha> [source]
vitehub content unpin [source]
vitehub content check [source] [--sha <sha>]
vitehub content check [source] --dir <folder> [--page-url <pattern>] [--schema <file>] [--site <url>] [--ignore <path>...] [--title-template <pattern>]
```

`check` prints each finding as `path:line  severity  code  message`, and exits with status 1 when one is an error. Against the app it calls `content.check()`. With `--dir` it checks a folder of the working tree as one Source and needs no app, for CI on content pull requests. `--json` prints the `ContentCheckResult`.

`head`, `advance`, `pin`, and `unpin` call `content.sources` of the app. Without a name, `head` shows every `github()` Source, and the others move the only one. With more than one, they ask for the name. Each head shows the commit, the pin, the last check, the rejected commit, the last webhook delivery, and `diagnostic` with its fix: `CONTENT_R0020` (no token), `CONTENT_R0021` (no KV store), `CONTENT_R0019` (the newest commit does not parse, and the head did not move after it), or `CONTENT_R0035` (GitHub answered 403 or 429 to the branch lookup). `advance` and `unpin` exit with status 1 when the head is held back. They need the `content` section of the Console access; `head` needs only `content:read`.

`previews comment` prints a Markdown comment with the `/pr/<number>` link of each page that a pull request adds or changes, from `content.sources.previewLinks()`. The links of a private pull request are signed. With `--post`, it creates the comment on GitHub, or updates the one that starts with `<!-- vitehub-content-previews -->`, with `VITEHUB_GITHUB_TOKEN` from the environment of the command. Without the token it fails with `CONTENT_R0077`, and when GitHub refuses it fails with `CONTENT_R0078`. The operation signs links, so it needs the whole `content` section of the Console access. Nothing runs it on its own: deploys and comments stay local, and a GitHub Action that runs it is opt-in.

Omit the id for a singleton. `edit` saves drafts with field issues and prints them; it honours edit leases unless `--override-lease`. `rm` deletes a draft after confirmation, and `restore` saves an earlier version as the draft; both pin the draft that they read and honour edit leases. `publish` and `schedule` pin the draft digests they list and refuse drafts with field issues. Every command accepts `--json`. Each command runs a `content.*` operation through the app's `POST /_vitehub/rpc` route. Without `--url` it calls the dev server; with `--url` it calls a deployed app that enables the Console, and signs each call with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. The operations call `content.can()` with the user of the call: the person that the Console signed, or no user for the CLI.

## ViteHub MCP

With the Console enabled, an agent on the ViteHub MCP of the Console lists readable collections and documents, reads drafts, and saves drafts through the same Content operations as the editor. Each call checks `content.can()` with the Console user. Saves require `ifDigest` and respect edit leases. The application module loads on the first call. See [ViteHub MCP](https://vitehub.dev/docs/development/mcp).
