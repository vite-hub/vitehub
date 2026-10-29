---
title: Comments
navigation.title: Overview
description: Let your team pin comments on the pages of your live site, reply, resolve, and edit Content text in place.
navigation.order: 1
icon: i-lucide-message-square-text
---

::product-hero{tagline="Pin comments on any page of your site, sign your team in with GitHub, and post threads to the pull request of the preview." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :::product-files
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
    const [error, threads] = await comments.list({ status: 'open' })
    if (error) throw error
    return threads.map(thread => thread.page)
  })
  ```
  :::
::

## Pick a setup

Start with one plugin. Add more when you need it, without changing what you have.

| Setup | You add | You get |
| --- | --- | --- |
| [Comments alone](/docs/comments/get-started) | `comments()` in `vite.config.ts` | Pins, threads, replies, and resolve on every page. Threads in a SQLite file that Comments creates. Guests on the dev server. |
| [With GitHub sign-in](/docs/comments/configure#sign-in-with-github) | A GitHub App, and three server variables | Your team signs in with GitHub. People who can push to the repository may comment. Comments posted to the pull request show their GitHub account. |
| [In a ViteHub app](/docs/comments/with-vite-hub) | `vitehub()` with a Database, and `server/comments.ts` | Any ViteHub Database, on every host. Cursors of the people on a page, Content edits in place, the Console section, MCP tools for Agents, and your own sign-in. |

::product-features
  :::product-feature-item{title="One plugin turns it on" icon="i-lucide-file-code-2" to="/docs/comments/get-started#turn-on-comments"}
  Add `comments()` to `vite.config.ts`. It adds the API, the overlay, and a SQLite file for the threads.
  :::

  :::product-feature-item{title="Sign in with GitHub" icon="i-lucide-github" to="/docs/comments/configure#sign-in-with-github"}
  People who can push to the repository may comment. The session is a cookie, so the server stores no users.
  :::

  :::product-feature-item{title="Public visitors get nothing extra" icon="i-lucide-eye-off" to="/docs/comments/configure#turn-comment-mode-on-and-off"}
  The overlay loads only for a request with `?comments` or the comment mode cookie.
  :::

  :::product-feature-item{title="Pins follow the text" icon="i-lucide-map-pin" to="/docs/comments/server-api#anchors"}
  A pin finds its element again after a resize or a layout change. A pin on a Content field keeps its place through a redesign.
  :::

  :::product-feature-item{title="See who is on the page" icon="i-lucide-users" to="/docs/comments/with-vite-hub#see-who-else-is-on-the-page"}
  With Realtime, everyone on a page sees the others' avatars and cursors, and new comments show at once.
  :::

  :::product-feature-item{title="Edit Content text in place" icon="i-lucide-pencil-line" to="/docs/comments/with-vite-hub#edit-content-text-in-place"}
  Mark an element with `contentField()`. An edit saves a Content draft, and you publish it in the Console.
  :::

  :::product-feature-item{title="Decide who can comment" icon="i-lucide-lock" to="/docs/comments/configure#decide-who-can-comment"}
  `authorize()` allows or denies `read`, `comment`, and `resolve` for each user, and can let guests comment.
  :::

  :::product-feature-item{title="Notify the people you mention" icon="i-lucide-at-sign" to="/docs/comments/configure#notify-mentioned-people"}
  `people` fills the `@` list. `onComment` runs after each comment, so you can send an Email.
  :::

  :::product-feature-item{title="Triage in the Console" icon="i-lucide-list-checks" to="/docs/comments/configure#triage-in-the-console"}
  The Comments section lists every thread with its page and status, and links back to the pin.
  :::
::

## Comments through Operations

To store numbered threads on custom subjects and authorize each CLI, MCP, Console, or browser operation, use a [default-export Comments Definition](/docs/comments/operations/get-started). The named `comments` export described above keeps the live-site overlay API. Use one entry form per application; they install different Database schemas.
