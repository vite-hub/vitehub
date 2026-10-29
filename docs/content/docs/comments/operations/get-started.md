---
title: Add comments to an app
description: Define who may comment, create the tables, and read the first thread from the CLI.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Add vitehub()

Comments live in your Database. `vitehub()` turns the Database on when `server/comments.ts` exists and you left `database` unset, and it adds the default Database Definition when the app has none. Add the Console so you can see the threads:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ console: { auth: 'app' } }),
    nitro(),
  ],
})
```

If you set `database: false`, the build fails with `COMMENTS_B0001` and names that setting.

## Define the policy

```ts [server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user, action }) => {
    if (!user) return false
    // Everyone signed in reads and writes. Only admins delete the comments of others.
    return action !== 'delete' || user.role === 'admin'
  },
})
```

## Create the tables

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate
```

## Read a thread

Create a thread from code or from the [UI parts](/docs/ui/comments), then list it:

```bash [Terminal]
pnpm vitehub comments list --json
pnpm vitehub comments get --id thread_123
```

Open the Console at `/_vitehub` and choose **Comments**. The list comes from `comments.list` with your sign-in, so it shows only the threads that `authorize` lets you read. Use the chips to filter by open, resolved, mine, or mentions. A page thread links to `<page>?comment=<n>`.

### In `vite dev`

With `console: { auth: false }`, or with no `console` option, and nobody signed in, `vite dev` runs every operation as the user `{ id: 'local', name: 'You' }`. `authorize` sees that user, and the comments you create have it as author, so you can try comments without Auth. A production build never does this: there, an unsigned call has no user, and writing fails with `COMMENTS_R0012`.

## Use it in the browser

```ts [app/comments.ts]
import { createCommentsClient } from 'vite-hub/comments/client'
import { createRpcTransport } from 'vite-hub/comments/rpc'

export const comments = createCommentsClient({
  transport: createRpcTransport(),
  user: { id: 'ana', name: 'Ana Ruiz' },
  query: { page: location.pathname },
})
```

## The overlay

Nothing else to add: the pages of your app now have comments. `vitehub()` puts one `<script type="module">` tag, a loader of about 3 KB, into the HTML of every page. In `vite dev` and in the build it goes into `index.html`. Pages that your server renders get it from a Nitro middleware, which also covers the pages Nitro prerenders. Under Nuxt it goes in through the `render:html` hook.

The loader asks the server `comments.session` with the visitor's cookie on allowed page loads and client-side navigation (see [Privacy](/docs/comments/operations/configure#content-security-policy-and-privacy) for the optional app-managed session marker). The answer is `{ user, canRead, canWrite }` and nothing else, and for a visitor who is not signed in it is `{ user: null, canRead: false, canWrite: false }` without running your `authorize` policy. Only when `canRead` is true does the loader download the overlay, about 160 KB (51 KB compressed). A visitor who is not signed in, or may not read comments, downloads nothing more, and sees nothing. If a later navigation finds that access has ended, the loader removes the overlay.

That is one small `POST` per page load, for every visitor of the pages that get the overlay, anonymous ones included: a request of a few hundred bytes with no database access for a visitor who is not signed in. The loader asks again on client-side navigation. Limit the pages with `overlay.paths` and `overlay.exclude` if that is more than you want.

Press `C` on a page, click a spot, and write. The toolbar at the bottom has the comment button, the list, and *Edit* when the page comes from the [Content](/docs/content) cms preset: the overlay asks `content.resolve` for the document at the page's URL and links to its editor in the Console. An app without Content has no such operation, so it has no Edit button. A visitor who may read but not write sees the threads without the writing tools.

The overlay lives in a shadow root on an element with `data-comments-ui`, so your styles do not reach it and its styles do not reach your page. It follows the color scheme of the visitor (`prefers-color-scheme`). It follows client-side navigation too: `history.pushState`, `history.replaceState`, and `popstate` change the page that the threads belong to, and `/pricing` and `/pricing/` are one page. When the app is in dark mode (a `dark` class, `data-theme="dark"`, or `color-scheme: dark` on `<html>`) the overlay is dark; without a choice of the app it follows `prefers-color-scheme`. Comments show their text as Markdown for the small subset notes use: paragraphs, line breaks, `code`, bold, italics, and links.

Turn it off, or limit it to some pages, in `vitehub()`:

```ts [vite.config.ts]
vitehub({ comments: { overlay: { paths: ['/docs/**'], exclude: ['/docs/internal/**'] } } })
vitehub({ comments: { overlay: false } })
```
