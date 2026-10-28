# @vite-hub/comments

`@vite-hub/comments` lets a team comment on a live ViteHub site, Figma style. People pin comments to any element of any page, reply, mention each other, and resolve threads. Everyone on the same page sees the pins, the people, and their cursors live. Where an element renders a Content field, the same person can edit its text in place, and the edit saves a Content draft.

Use [`vite-hub`](https://www.npmjs.com/package/vite-hub), which wires the package for you. It needs a Database. Presence needs Realtime with a room authority.

## Turn it on

```ts
// server/comments.ts
import { defineComments } from "vite-hub/comments"

export const comments = defineComments({
  // Who may read, comment, and resolve. Without it, any signed-in ViteHub Auth user may do everything.
  authorize: ({ user }) => user?.role === "editor",
})
```

ViteHub then adds the `vitehub_comment_threads` and `vitehub_comments` tables to the default Database (or the only one, or `defineComments({ database: "name" })`), serves `/api/_vitehub/comments/**`, and adds a Comments section to the Console. Apply the tables with `vitehub db generate` and `vitehub db migrate`.

Open any page with `?comments`. The server adds the overlay script to that page, and the session route sets the `vitehub-comments` cookie so later pages open in comment mode too. The cookie is a hint, never a credential: every route checks `authorize` again. A request without the hint gets the page unchanged.

When the app has the Console, its Comments section controls access, and opening the Console enables the toolbar on the app's pages. Custom `identify` runs after that access check. Without the Console, custom `identify` takes precedence over ViteHub Auth, and Comments reads the Auth session only when `identify` is absent.

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

## Deployment and security boundaries

- Threads live only in the Database. Presence rooms hold no document, and connections are read-only. The server binds each person's presence to the user that `identify` or the Auth session resolves.
- Pins anchor to the Content field first, then a CSS path checked against the element text, then the text alone, then the page point. A pin whose element is gone shows dashed.
- A thread change tells the other tabs of the page through the Realtime events room, and they read the threads again. Changes from the server API reach open pages when they refetch: on focus and every 30 seconds.
- Without a Realtime authority, such as on Vercel, comments work without presence or cursors.
- Write routes compare `Origin` with the request origin, and honour `X-Forwarded-Proto` and `X-Forwarded-Host` from a proxy that ends TLS.
- Guests can comment only when `authorize` allows `user: null`. They name themselves in the browser, and their names and IDs are display data only. Guests cannot delete comments or threads.
- The overlay is a custom element with a shadow root, so the page's CSS does not reach it.

## Public imports

| Import | Purpose |
| --- | --- |
| `@vite-hub/comments` | `defineComments()`, `installComments()`, and types. |
| `@vite-hub/comments/anchor` | DOM anchoring: `createAnchor()`, `placeAnchor()`, `selectorOf()`, `labelOf()`. |
| `@vite-hub/comments/database` | `commentsSchema`, the Drizzle tables. |
| `@vite-hub/comments/realtime` | `commentsRealtime()`, the presence room Realtime Definition. |
| `@vite-hub/comments/runtime` | `createCommentsHandler()` and `defineCommentsPlugin()` for a manual Nitro setup. |
| `@vite-hub/comments/vite` | `hubComments()` discovery and generated server wiring. |

Generated files under `.vitehub/nitro/comments` are inspectable build output, not application imports.

## Learn more

- [Comments](https://vitehub.dev/docs/comments) covers access, guests, mentions, hosts, and errors.
- [Content](https://vitehub.dev/docs/content) covers collections, drafts, and publishing.
- [Realtime](https://vitehub.dev/docs/realtime) covers room authorities.
