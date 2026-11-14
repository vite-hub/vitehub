# @vite-hub/comments

`@vite-hub/comments` lets a team comment on a live ViteHub site, Figma style. People pin comments to any element of any page, reply, mention each other, and resolve threads. Everyone on the same page sees the pins, the people, and their cursors live. Where an element renders a Content field, the same person can edit its text in place, and the edit saves a Content draft.

## Turn it on

```bash
pnpm add @vite-hub/comments
```

```ts
// vite.config.ts
import { defineConfig } from "vite"
import comments from "@vite-hub/comments/vite"

export default defineConfig({ plugins: [comments()] })
```

There is nothing else to set up. `comments()` adds Nitro as the server unless the app has it, serves the Comments API, and keeps threads in `.vitehub/data/comments.sqlite`, a file that it opens with Node's built-in `node:sqlite` and creates the tables in. On the dev server, anyone may comment as a guest. Open any page with `?vitehub`.

A production build connects to `DATABASE_URL`, `TURSO_DATABASE_URL`, or a Cloudflare D1 binding `DB`, whichever the server has. Or point it somewhere: `comments({ database: "d1:COMMENTS" })`, `"env:COMMENTS_DATABASE_URL"`, or `"file:./data/comments.sqlite"` on Node. Comments creates its tables there on first use, and moves the tables of an earlier version before its first query, so there is no migration to run.

### Sign in with GitHub

Create a GitHub App, install it on the repository, and list `https://<site>/api/_vitehub/comments/auth/callback/github` as its callback URL. Then set `VITEHUB_GITHUB_CLIENT_ID`, `VITEHUB_GITHUB_CLIENT_SECRET`, and `VITEHUB_SECRET` on the server. People who can push to the repository may comment. The session is an encrypted cookie, so the server stores no users.

### In a ViteHub app

[`vite-hub`](https://www.npmjs.com/package/vite-hub) wires the package for you, with any ViteHub Database, presence over Realtime, Content edits in place, the Console, and MCP tools.

```ts [server/comments.ts]
// server/comments.ts
import { defineComments } from "vite-hub/comments"

export const comments = defineComments({
  // Who may read, comment, and resolve. Without it, a production build lets in only people signed in with GitHub who
  // can push to the repository, and people that the Console admits to Comments; everyone may on the dev server.
  authorize: ({ user }) => user?.role === "editor",
})
```

Without the file, `vitehub({ comments: true })` turns Comments on with `defineComments()`, and so does an object such as `{ database: "team" }`. The Console does not turn it on. `comments: false` turns it off. Docs sites of `@vite-hub/docs` on `vite-hub/nuxt` set it by default; `docs: { comments: false }` turns it off.

ViteHub then adds the `vitehub_comment_threads`, `vitehub_comment_messages`, `vitehub_comment_counters`, and `vitehub_comment_forge` tables to the default Database (or the only one, or `defineComments({ database: "name" })`; without a Database Definition, the implicit `default` Database of `@vite-hub/database`), serves `/api/_vitehub/comments/**`, and adds a Comments section to the Console. Apply the tables with `vitehub database generate` and `vitehub database migrate`.

A ViteHub Database with the tables of the earlier live-site model must move them once in a migration: see [Upgrade to one model](https://vitehub.dev/docs/comments/configure#upgrade-to-one-model). Until then every Comments request fails with `COMMENTS_R0019`, whose `fix` names `commentsMigrationSql({ from: "live" })`. `migrateComments(db)` from `@vite-hub/comments/database` moves them in place and keeps the old tables as a backup.

Comments is a ViteHub page tool. Open any page with `?vitehub`, or `?vitehub=comments`. The server adds the page tools loader to that page. The loader calls `GET /_vitehub/page/session`, which allows Comments when `authorize` allows `read` or offers GitHub sign-in or account switching, and sets the `vitehub-tools` cookie so later pages open in comment mode too. The loader then draws the ViteHub tools pill at the bottom of the page and imports the overlay. The overlay draws its toolbar in its segment of the pill, and its pins, cursors, and cards in `<vitehub-comments>`. The pill's **×** button turns the page tools off, so the toolbar has no close button of its own. A small ViteHub hexagon then stays at the pill's place, on every page, and pressing it turns them on again. The cookie is a hint, never a credential: every Comments route checks `authorize` again. A request without the hint gets the page with a short inline bootstrap that loads the loader in the browser only when the hint is there, so prerendered pages that a host serves as static files work too. Opening the Console calls the same session route, so the Console's people see the toolbar on the app's pages. The session route and the loader do not need the Console.

A single page app whose `index.html` Vite serves or builds gets a short inline check in that file. It imports the loader in the browser when the page has the query or the cookie, so a built `index.html` that a host serves as a static file also gets the tools. When the app has a Vite `base` or a Nuxt `app.baseURL`, such as `/docs/`, every path follows it: `/docs/_vitehub/page/session`, `/docs/_vitehub/page/assets/loader.js`, and `/docs/api/_vitehub/comments/**`. The loader and the overlay find the base from their own URL, including the overlay's Realtime presence and live update connections.

Custom `identify` names the user of every surface, and `authorize` decides; Comments then reads neither the Auth session nor the Console's access. Without `identify`, when the app has the Console, its Comments section controls access, and opening the Console enables the toolbar on the app's pages. Otherwise Comments reads the Auth session.

By default the overlay comments on the page itself, `{ kind: "page", id: "/pricing" }`. `page` maps a page to a subject of your own. The server decides: the overlay reads the subject from the session route, and a thread that the overlay starts must be on that subject. `authorize` still runs on it. A `page` given to the API, as the `?page=` query of a route such as `GET /threads?page=/pricing` or in the body of `POST /threads`, means that same subject.

```ts fragment
import { defineCommentSubject, defineComments } from "vite-hub/comments"

export const comments = defineComments({
  subjects: [defineCommentSubject({ kind: "drop", scope: id => `drop:${id}` })],
  page: async ({ url }) => {
    const id = url.pathname.match(/^\/d\/([^/]+)/)?.[1]
    return id ? { kind: "drop", id, revision: await latestRevision(id) } : undefined
  },
})
```

`url` has the origin and the normalized path, without query and hash. Return `undefined` or `null` for the page itself. With `revision`, new threads from the overlay start on the version that the person saw: the overlay sends the `revision` that `/session` gave for the page, and the server keeps it when it is not newer than the one `page` gives now. A missing or newer revision becomes the one from `page`.

Console `comments:read` access allows reading threads and joining presence. Writes also require full `comments` access and the Comments policy.

Press `C` and click the page to start a thread, or press `B` to draw on the page with a marker, a pen, arrows, or text labels and comment with a picture of it. Press `E` to edit text that `contentField()` marks:

```vue
<script setup lang="ts">
import { contentField } from "vite-hub/content/client"
</script>

<template>
  <h1 v-bind="contentField('about', 'hero.title')">{{ page.hero.title }}</h1>
  <span v-bind="contentField('customers', customer.id, 'name')">{{ customer.name }}</span>
</template>
```

An edit reads the draft, changes one string field, and saves the document with `ifDigest`. It needs `content.can({ action: "write" })`. Publishing stays in the Content publish flow.

## Server API

Every method returns `[error, data]`.

```ts fragment
import { comments } from "~/server/comments"

const [error, threads] = await comments.list({ page: "/pricing", status: "open" })
// threads[0].messages[0].body, threads[0].subject: { kind: "page", id: "/pricing" }
await comments.reply(threadId, { body: "Fixed in the draft", author: { id: "agent", name: "Docs Agent" } })
await comments.resolve(threadId, { by: { id: "agent", name: "Docs Agent" } })
```

## Post to the pull request

On a preview, `forge: { provider: "github" }` posts each thread to the pull request that the build previews: one summary comment that lists every thread, then one comment per comment, with the page, the element, the components, and the browser. Resolving a thread hides its comment. It posts with the GitHub App of `VITEHUB_GITHUB_APP_ID` and `VITEHUB_GITHUB_PRIVATE_KEY`, or as each person: people who signed in with GitHub post as themselves, and `token(author)` returns the token for any other sign-in. Each thread's `forge` field says whether it posted.

## Deployment and security boundaries

- Threads live only in the Database. Presence rooms hold no document, and connections are read-only. The server binds each person's presence to the user that `identify` or the Auth session resolves.
- Pins anchor to the Content field first, then a CSS path checked against the element text, then the text alone, then the page point. A pin whose element is gone shows dashed.
- A thread change tells the other tabs of the page through the Realtime events room, and they read the threads again. Changes from the server API reach open pages when they refetch: on focus and every 30 seconds.
- Without a Realtime authority, such as on Vercel, comments work without presence or cursors.
- Write routes compare `Origin` with the request origin, and honour `X-Forwarded-Proto` and `X-Forwarded-Host` from a proxy that ends TLS.
- Page context stores only the URL origin and pathname, validated against the request origin and thread page. Query parameters, URL credentials, and fragments are discarded. Nuxt component files come from its resolved component registry.
- Guests can comment only when `authorize` allows `user: null`. They name themselves in the browser, and their names and IDs are display data only. Guests cannot delete comments or threads.
- The overlay is a custom element with a shadow root, so the page's CSS does not reach it.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/comments` | `defineComments()` and types. `installComments()` is in `@vite-hub/comments/server`. |
| `@vite-hub/comments/client` | Framework-free client, transport types, `createAnchor()`, and `resolveAnchor()`. |
| `@vite-hub/comments/testing` | In-memory client transport for tests and examples. |
| `@vite-hub/comments/anchor` | DOM anchoring: `createAnchor()`, `placeAnchor()`, `selectorOf()`, `labelOf()`. |
| `@vite-hub/comments/database` | `commentsSchema`, the Drizzle tables, and `commentsTables`, the statements that create them. |
| `@vite-hub/comments/realtime` | `commentsRealtime()`, the presence room Realtime Definition. |
| `@vite-hub/comments/runtime` | `createCommentsHandler()` and `defineCommentsPlugin()` for a manual Nitro setup; `commentsMcpTools()` for an app's own MCP server. |
| `@vite-hub/comments/vite` | `comments()`, the plugin for apps without `vite-hub`, and `hubComments()`, the integration that `vitehub()` adds. |
| `@vite-hub/comments/runtime/connect` | `connectDatabase()` of `@vite-hub/database/connect`, for the files that `comments()` generates. `/node` also opens SQLite files. |

Generated files under `.vitehub/nitro/comments` are inspectable build output, not application imports.

`createCommentsHandler(options)` returns a Fetchable, `{ fetch(request) }`. Mount it as a Nitro or H3 route at `/api/_vitehub/comments/**`, or call `handler.fetch(request)` yourself. Every outcome is a `Response`, also the errors. The handler gives the Request to `identify` as `event`, and reads cookies, the Cloudflare bindings, and `waitUntil` from its Standard Context, `request["~standard"]`. In a ViteHub app, Nitro sets it. For a Request from elsewhere, the handler sets it.

```ts
import { createCommentsHandler } from "@vite-hub/comments/runtime";
import { comments } from "./server/comments";

const handler = createCommentsHandler({ comments, realtime: false });
const response = await handler.fetch(new Request("https://site.test/api/_vitehub/comments/threads?page=/"));
```

`commentsMcpTools(comments)` returns tools with `call(input, { user })`, where your server authenticates `user` or passes `null` for an anonymous caller. With a request `event`, such as the Request or an H3 event, a configured Comments `identify` or session reader takes precedence over `user`. See [Fix comments with an Agent](https://vitehub.dev/docs/comments/configure#fix-comments-with-an-agent).

## Learn more

- [Comments](https://vitehub.dev/docs/comments) covers access, guests, mentions, hosts, and errors.
- [Content](https://vitehub.dev/docs/content) covers collections, drafts, and publishing.
- [Realtime](https://vitehub.dev/docs/realtime) covers room authorities.

### Floating window

Comments loads when its pill button is first used. Its thread list and replies open in the shared page-tools window. Expand or minimize it without replacing the reply form. Navigation updates the thread list to the current page. The pill asks before turning off tools with an unsent comment.

Select **Edit**, then a marked field, to edit plain text in place. A field that is not plain text says to edit it in the Console at console.vitehub.dev. The Content write and publish rules do not change.

## One model

The overlay, the server API, the comment operations, the browser client, the Console, and MCP share one model: threads on a subject, numbered `n` in a scope, with Markdown `messages`, mentions as ids, `metadata`, an optional subject `revision`, and attachments. One `authorize` policy decides on every surface.

`server/comments.ts` exports one definition, as `comments` or as the default export. Either form runs every surface: the overlay and the Comments API, presence rooms, the MCP tools, and the comment operations of the Console, the CLI, and MCP. See [Comment operations](https://vitehub.dev/docs/comments/operations/get-started). Threads live in `commentsSchema` from `/database`, or `commentsPostgresSchema` from `/database/postgres` with `vitehub({ comments: { dialect: "postgresql" } })`.

## Browser client

Figma-style comments for your own running app. A signed-in team member drops a pin on any spot of a page, and the team replies in the thread.

This package holds what the server and the UI share:

- `@vite-hub/comments/client` exports the browser types: `CommentThread`, `CommentMessage`, `CommentAnchor`, `CommentSubject`, `CommentUser`, `CommentStatus`, and the `CommentsTransport` contract.
- `@vite-hub/comments/client` has no framework. It makes anchors, finds them again, and calls the comment operations through a transport.
- `@vite-hub/comments/testing` has `createMemoryTransport()` for tests and docs examples.

The Vue parts are in `@vite-hub/ui`. Use `createRestTransport()` from `@vite-hub/comments/client` for the Comments API, which guests and share-link readers can use too, or `createRpcTransport()` from `@vite-hub/comments/rpc` for the operations RPC on a development server. A browser cannot sign Console calls, so the RPC transport works only with `console: { auth: false }` or without the `console` option. `transport.attachmentUrl(key)` of the REST transport is the URL of an attachment for people who may read its thread. The overlay uses the anchoring API of `@vite-hub/comments/anchor`, which writes `element` anchors with placement hints.

## Anchors

An anchor says where a comment sits, so the pin can find the spot again after the layout changes.

```ts
import { createAnchor, resolveAnchor } from "@vite-hub/comments/client";

document.addEventListener("click", (event) => {
  // From a click: the element under the point, plus where in its box the click landed.
  const anchor = createAnchor({ x: event.clientX, y: event.clientY });
  // { kind: "element", selector: "#pricing > div > button", x: 480, y: 310 }

  const position = resolveAnchor(anchor);
  if (position.detached) {
    // The element is gone, hidden, or no longer holds the quote.
  } else {
    position.x; // The pin position in client coordinates.
  }
});
```

| Kind | Made from | Keeps |
| --- | --- | --- |
| `page` | `"page"` | Nothing. The whole page. |
| `element` | an element, or a point | The element selector and a point in thousandths of its box. |
| `text` | a `Selection` or a `Range` | The selector of the nearest element, and the quote as `exact`, `prefix`, `suffix`. |
| `area` | an element and `options.area` | The selector and a rectangle in thousandths. |
| `image` | an `img`, with a point or `options.area` | The same as `element` or `area`, on an image. |

The selector uses the first of these that names exactly one element: `data-comment-id`, `id`, `data-testid`. Else it is a short path such as `#plans > div > p:nth-of-type(2)`. Ids that a framework makes up, such as React's `:r1:`, `radix-…`, `headlessui-…`, or Vue's `v-1`, and ids that are mostly digits or hashes, are skipped. Add `data-comment-id` to an element that must keep its comments when the markup changes.

`resolveAnchor()` never guesses. A selector that names more than one element is ambiguous, so the anchor is detached. A text anchor tries every match and takes the one that holds the quote. A quote that occurs more than once needs enough text around it to match, else the anchor is detached. A resolved anchor has `clipped: true` when a scroll container or an `overflow: hidden` ancestor cuts the spot off. Hide the pin then.

Offsets are in thousandths of the element box: `500` is the middle. A pin follows its element when the window resizes.

## Client

```ts
import { createAnchor, createCommentsClient, createRestTransport } from "@vite-hub/comments/client";

const client = createCommentsClient({
  transport: createRestTransport(), // the Comments API; see Transport below
  user: { id: "ana", name: "Ana Ruiz" },
  query: { page: location.pathname },
});

const stop = client.start(); // Loads the threads, then keeps them fresh.
await client.create({
  subject: { kind: "page", id: location.pathname },
  anchor: createAnchor(document.querySelector("#pricing button")!),
  body: "This button is too small.",
});
client.threads; // The cached threads, ordered by number.
client.onChange(() => console.log(`${client.threads.length} threads`));
```

To retry a create safely, give it a `requestId`, such as `crypto.randomUUID()`, and keep it for that draft. A second create with the same `requestId` in the same scope returns the first thread and creates no new thread. Only the author of the first thread gets it back, for the same subject, and only when that author may still read it. Anything else fails: the Operations and `POST /threads` answer `409` with `COMMENTS_R0022`, and the server API `comments.create()` returns `COMMENTS_INVALID_INPUT` with the reason. Make a new `requestId` for each new comment.

`start()` listens to the transport's `subscribe`, such as Realtime. Without `subscribe` it refreshes when the window gets focus. A list that comes back late never undoes a thread that was created, changed, or deleted while it was on its way, and an event that is older than the stored thread is ignored. A transport that lost its connection sends `{ type: "reconnected" }` when it has it again, and the client lists the threads once more.

Without an explicit query `limit`, refresh loads every page. Multi-page refreshes require two matching scans before replacing the cache. If three scans cannot agree because the list keeps changing, refresh raises `COMMENTS_R0015` and preserves the previous cache; refresh again to retry. An explicit `limit` makes one request.

### Transport

A transport is the seam to the server. Each method has the name and the input of one `comments.*` operation.

```ts
import type { CommentCreateInput, CommentDeleteInput, CommentEditInput, CommentEvent, CommentGetInput, CommentListQuery, CommentReplyInput, CommentStatusInput, CommentThread, CommentUser, CommentUsersInput } from "@vite-hub/comments"

interface CommentsTransport {
  supportsAttachments?: boolean; // Defaults to true for custom transports.
  list(query: CommentListQuery): Promise<CommentThread[]>;
  get(input: CommentGetInput): Promise<CommentThread | null>; // { id } or { scope, n }
  create(input: CommentCreateInput): Promise<CommentThread>;
  reply(input: CommentReplyInput): Promise<CommentThread>;
  edit(input: CommentEditInput): Promise<CommentThread>;
  delete(input: CommentDeleteInput): Promise<CommentThread | null>;
  resolve(input: CommentStatusInput): Promise<CommentThread>;
  reopen(input: CommentStatusInput): Promise<CommentThread>;
  users(input: CommentUsersInput): Promise<CommentUser[]>;
  subscribe?(listener: (event: CommentEvent) => void): () => void;
}
```

A mutation returns the thread as it is afterwards. `delete` returns `null` when the thread is gone.

Transports accept attachment keys by default, including the shipped `createRpcTransport()`. Custom transports that reject attachment keys should set `supportsAttachments: false` to disable file controls in comment surfaces.

`createMemoryTransport()` keeps threads in memory. Use it in tests and docs examples:

```ts
import { createCommentsClient } from "@vite-hub/comments/client";
import { createMemoryTransport } from "@vite-hub/comments/testing";

const ana = { id: "ana", name: "Ana Ruiz" };
const transport = createMemoryTransport({ user: ana });
const client = createCommentsClient({ transport, user: ana });
```

`transport.as(user)` gives another person on the same store, and `transport.reconnect()` sends `reconnected` to the listeners.

## Errors

Errors have a stable code, a `why`, and a `fix`.

| Code | Meaning |
| --- | --- |
| `COMMENTS_R0001` | `createAnchor()` found nothing to anchor to. |
| `COMMENTS_R0002` | The thread does not exist. |
| `COMMENTS_R0003` | The message does not exist in the thread. |
| `COMMENTS_R0004` | Only the author can edit or delete a message. |
| `COMMENTS_R0005` | A comment needs some text. |
