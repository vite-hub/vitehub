---
title: Comments
navigation.title: Overview
description: Let your team pin comments on the pages of your live site, reply, resolve, and edit Content text in place.
navigation.order: 1
icon: i-lucide-message-square-text
---

::product-hero{tagline="Pin comments on any page of your site, see who else is there, and fix Content text where you read it." hosts="Node, Docker, Cloudflare, Vercel, Netlify"}
  :::product-files
  ```ts [server/comments.ts]
  import { defineComments } from 'vite-hub/comments'

  // One file turns Comments on.
  export const comments = defineComments({
    // Only editors may comment. Default: any signed-in user.
    authorize: ({ user }) => user?.role === 'editor',
  })
  ```

  ```ts [vite.config.ts]
  import vue from '@vitejs/plugin-vue'
  import { vitehub } from 'vite-hub'
  import { defineConfig } from 'vite'

  export default defineConfig({
    plugins: [
      vue(),
      vitehub({
        preset: 'node',
        // Threads go to this Database
        database: true,
        // Presence and cursors on each page
        realtime: { authority: 'memory' },
      }),
    ],
  })
  ```

  ```vue [src/pages/About.vue]
  <script setup lang="ts">
  import { contentField } from 'vite-hub/content/client'

  defineProps<{ about: { hero: { title: string } } }>()
  </script>

  <template>
    <!-- Editors can change this text on the page -->
    <h1 v-bind="contentField('about', 'hero.title')">
      {{ about.hero.title }}
    </h1>
  </template>
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

::product-features
  :::product-feature-item{title="One file turns it on" icon="i-lucide-file-code-2" to="/docs/comments/get-started#turn-on-comments"}
  Export `comments` from `server/comments.ts`. ViteHub adds the API, the tables, and the overlay.
  :::

  :::product-feature-item{title="Public visitors get nothing extra" icon="i-lucide-eye-off" to="/docs/comments/configure#turn-comment-mode-on-and-off"}
  The overlay loads only for a request with `?comments` or the comment mode cookie.
  :::

  :::product-feature-item{title="Pins follow the text" icon="i-lucide-map-pin" to="/docs/comments/server-api#anchors"}
  A pin finds its element again after a resize or a layout change. A pin on a Content field keeps its place through a redesign.
  :::

  :::product-feature-item{title="See who is on the page" icon="i-lucide-users" to="/docs/comments/get-started#see-who-else-is-on-the-page"}
  With Realtime, everyone on a page sees the others' avatars and cursors, and new comments show at once.
  :::

  :::product-feature-item{title="Edit Content text in place" icon="i-lucide-pencil-line" to="/docs/comments/configure#mark-content-fields"}
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
