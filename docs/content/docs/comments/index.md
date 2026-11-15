---
title: Comments
layout: landing
navigation.title: Overview
description: Let your team pin comments on the pages of your live site, reply, resolve, and edit Content text in place.
navigation.order: 1
icon: i-lucide-message-square-text
---

::product-hero{tagline="Pin comments on any page of your site, sign in with GitHub, and post threads to the preview's pull request." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :hero-figure{name="comments"}
::

::code-tree
```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import comments from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

// One plugin turns Comments on. No Database, no login of your own.
export default defineConfig({
  plugins: [vue(), comments()],
})
```

```bash [.env]
# Sign in with GitHub: people who can push to the repository may comment
VITEHUB_GITHUB_CLIENT_ID=Iv23li...
VITEHUB_GITHUB_CLIENT_SECRET=...
VITEHUB_SECRET=...
```

```ts [server/comments.ts]
import { defineComments } from '@vite-hub/comments'

// Optional: change who may comment, and post threads to pull requests.
export const comments = defineComments({
  authorize: ({ user, action }) => action === 'read' || user?.github?.write === true,
  forge: { provider: 'github' },
})
```

```ts [server/api/open-threads.get.ts]
import { defineEventHandler } from 'h3'
import { comments } from '../comments'

// The same threads, from server code
export default defineEventHandler(async () => {
  const [error, threads] = await comments.list({ subjectKind: 'page', status: 'open' })
  if (error) throw error
  // A page thread's subject id is the app path
  return threads.map(thread => ({ n: thread.n, page: thread.subject.id }))
})
```
::

## Pick a setup

Start with one plugin and add more later.

| Setup | You add | You get |
| --- | --- | --- |
| [Comments alone](/docs/comments/get-started) | `comments()` in `vite.config.ts` | Pins, threads, replies, and resolve on every page. Threads in your database, Turso, Cloudflare D1, or a SQLite file, in tables Comments creates. Guests on the dev server. |
| [With GitHub sign-in](/docs/comments/configure#sign-in-with-github) | A GitHub App and three server variables | People who can push to the repository sign in and comment. Pull request comments show their GitHub account. |
| [In a ViteHub app](/docs/comments/with-vite-hub) | `vitehub()` with a Database, and `server/comments.ts` | Any ViteHub Database on every host. Live cursors, Content edits in place, the Console section, MCP tools for Agents, and your own sign-in. |
| [On a docs site](/docs/docs-site/configure#comments) | `vite-hub/nuxt` beside `@vite-hub/docs/nuxt` | On by default on every docs page, with threads in the Console. `docs: { comments: false }` turns it off. |

::product-features
  :::product-feature-item{title="One plugin turns it on" icon="i-lucide-file-code-2" to="/docs/comments/get-started#turn-on-comments"}
  Add `comments()` to `vite.config.ts` to get the API, the overlay, and a SQLite file for threads.
  :::

  :::product-feature-item{title="Sign in with GitHub" icon="i-lucide-github" to="/docs/comments/configure#sign-in-with-github"}
  People who can push to the repository may comment. The session is a cookie; the server stores no users.
  :::

  :::product-feature-item{title="Public visitors get nothing extra" icon="i-lucide-eye-off" to="/docs/comments/configure#turn-comment-mode-on-and-off"}
  The overlay loads only for readers that `authorize` allows, on a request with `?vitehub` or the `vitehub-tools` cookie.
  :::

  :::product-feature-item{title="Pins follow the text" icon="i-lucide-map-pin" to="/docs/comments/server-api#anchors"}
  A pin finds its element after a resize or layout change. A pin on a Content field survives a redesign.
  :::

  :::product-feature-item{title="See who is on the page" icon="i-lucide-users" to="/docs/comments/with-vite-hub#see-who-else-is-on-the-page"}
  With Realtime, people on a page see each other's avatars and cursors, and new comments appear at once.
  :::

  :::product-feature-item{title="Edit Content text in place" icon="i-lucide-pencil-line" to="/docs/comments/with-vite-hub#edit-content-text-in-place"}
  Mark an element with `contentField()`. Edits save a Content draft that you publish in the Console.
  :::

  :::product-feature-item{title="Decide who can comment" icon="i-lucide-lock" to="/docs/comments/configure#decide-who-can-comment"}
  `authorize()` allows or denies `read`, `write`, `resolve`, and `delete` per user, and can let guests comment.
  :::

  :::product-feature-item{title="Notify the people you mention" icon="i-lucide-at-sign" to="/docs/comments/configure#notify-mentioned-people"}
  `people` fills the `@` list. `onComment` runs after each comment, for example to send an Email.
  :::

  :::product-feature-item{title="Triage in the Console" icon="i-lucide-list-checks" to="/docs/comments/configure#triage-in-the-console"}
  The Comments section lists each thread with its page and status, and links to the pin.
  :::
::

## Comments through Operations

The same `server/comments.ts` also runs the [comment operations](/docs/comments/operations/get-started): numbered threads on your own subjects, for the CLI, MCP, the Console, and your UI. Export the definition as `comments` or as the default export. Both use the same tables.
