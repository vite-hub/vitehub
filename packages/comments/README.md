# @vite-hub/comments

`@vite-hub/comments` lets a team comment on a live ViteHub site, Figma style. People pin comments to any element of any page, reply, mention each other, and resolve threads. Everyone on the same page sees the pins, the people, and their cursors live. Where an element renders a Content field, the same person can edit its text in place, and the edit saves a Content draft.

## Turn it on

```bash
pnpm add @vite-hub/comments
```

```ts
// vite.config.ts
import comments from "@vite-hub/comments/vite"

export default defineConfig({ plugins: [comments()] })
```

There is nothing else to set up. `comments()` adds Nitro as the server unless the app has it, serves the Comments API, and keeps threads in `.vitehub/data/comments.sqlite`, a file that it opens with Node's built-in `node:sqlite` and creates the tables in. On the dev server, anyone may comment as a guest. Open any page with `?comments`.

A production build needs a database: a file on a disk that lasts, `comments({ database: "file:./data/comments.sqlite" })`, or on Cloudflare Workers a D1 binding, `comments({ database: { d1: "COMMENTS" } })`. Comments creates its tables in either, so there is no migration.

### Sign in with GitHub

Create a GitHub App, install it on the repository, and list `https://<site>/api/_vitehub/comments/auth/callback/github` as its callback URL. Then set `VITEHUB_GITHUB_CLIENT_ID`, `VITEHUB_GITHUB_CLIENT_SECRET`, and `VITEHUB_SECRET` on the server. People who can push to the repository may comment. The session is an encrypted cookie, so the server stores no users.

### In a ViteHub app

[`vite-hub`](https://www.npmjs.com/package/vite-hub) wires the package for you, with any ViteHub Database, presence over Realtime, Content edits in place, the Console, and MCP tools.

```ts
// server/comments.ts
import { defineComments } from "vite-hub/comments"

export const comments = defineComments({
  // Who may read, comment, and resolve. Without it, people signed in with GitHub who can push to the repository, and
  // users of any other sign-in, may do everything; guests may on the dev server only.
  authorize: ({ user }) => user?.role === "editor",
})
```

ViteHub then adds the `vitehub_comment_threads` and `vitehub_comments` tables to the default Database (or the only one, or `defineComments({ database: "name" })`), serves `/api/_vitehub/comments/**`, and adds a Comments section to the Console. Apply the tables with `vitehub db generate` and `vitehub db migrate`.

Open any page with `?comments`. The server adds the overlay script to that page, and the session route sets the `vitehub-comments` cookie so later pages open in comment mode too. The cookie is a hint, never a credential: every route checks `authorize` again. A request without the hint gets the page unchanged.

Press `C` and click the page to start a thread. Press `E` to edit text that `contentField()` marks:

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

```ts
import { comments } from "~/server/comments"

const [error, threads] = await comments.list({ page: "/pricing", status: "open" })
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
- Guests can comment only when `authorize` allows `user: null`. They name themselves in the browser, and their names are display text only.
- The overlay is a custom element with a shadow root, so the page's CSS does not reach it.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/comments` | `defineComments()`, `installComments()`, and types. |
| `@vite-hub/comments/anchor` | DOM anchoring: `createAnchor()`, `placeAnchor()`, `selectorOf()`, `labelOf()`. |
| `@vite-hub/comments/database` | `commentsSchema`, the Drizzle tables. |
| `@vite-hub/comments/realtime` | `commentsRealtime()`, the presence room Realtime Definition. |
| `@vite-hub/comments/runtime` | `createCommentsHandler()` and `defineCommentsPlugin()` for a manual Nitro setup. |
| `@vite-hub/comments/vite` | `comments()`, the plugin for apps without `vite-hub`, and `hubComments()`, the integration that `vitehub()` adds. |
| `@vite-hub/comments/runtime/sqlite` | `openCommentsSqlite()`, the SQLite file of `comments()`. |
| `@vite-hub/comments/runtime/d1` | `openCommentsD1()`, the Cloudflare D1 binding of `comments()`. |

Generated files under `.vitehub/nitro/comments` are inspectable build output, not application imports.

## Learn more

- [Comments](https://vitehub.dev/docs/comments) covers access, guests, mentions, hosts, and errors.
- [Content](https://vitehub.dev/docs/content) covers collections, drafts, and publishing.
- [Realtime](https://vitehub.dev/docs/realtime) covers room authorities.
