---
title: Add comments to an app
description: Define who may comment, create the tables, and read the first thread from the CLI.
layout: tutorial
navigation.title: Operations tutorial
navigation.order: 21
icon: i-lucide-rocket
---

Comments let people talk about something in your app, such as a page, an order, or a design. Each conversation is a thread. Your server decides who may read, write, and delete.

In this tutorial, you write the rule for who may comment, create the database tables, and read threads from the terminal and the Console. The [Console](/docs/console) is the ViteHub admin app at console.vitehub.dev. It calls your app.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). You need no account and no API key. Comments are saved in your app's Database.

## Add the Console

Install Comments and the Database packages:

```bash pm [commands/install]
pnpm add @vite-hub/comments @vite-hub/database drizzle-orm@1.0.0-rc.5
pnpm add -D drizzle-kit
```

Add the Console to the ViteHub options of your app:

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', console: { auth: false } },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', console: { auth: false } }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', console: { auth: false } })],
})
```
::::
:::

- You do not turn on the Database yourself. When `server/comments.ts` exists, `vitehub()` turns it on and adds a default Database.
- `console` adds the Console, so you can see the threads. `auth: false` means no sign-in. Use it only on your own computer. Before you deploy, [link the app in the Console](/docs/console/get-started#link-a-deployed-app).

If you set `database: false`, the build fails with `COMMENTS_B0001`.

## Define the policy

Create `server/comments.ts`. Its `authorize` function decides each action. Return `true` to allow it and `false` to refuse it.

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

Here, every signed-in user reads and writes. Only an admin deletes the comments of other people.

## Create the tables

Create the tables that hold the threads:

```bash [commands/migrate]
pnpm vitehub database generate
pnpm vitehub database migrate
```

## Read a thread

Start the dev server. The `vitehub comments` commands call it, so keep it running:

```bash [commands/start]
pnpm dev
```

In a second terminal, create a thread on the `/` page. You can also create threads from code or from the [UI parts](/docs/ui/comments).

```bash [commands/create-thread]
pnpm vitehub comments create --subject '{"kind":"page","id":"/"}' --anchor '{"kind":"page"}' --body 'First comment'
```

The answer is the new thread. Its `id` starts with `thread_`, and its author is `{ "id": "local", "name": "You" }`. Then list the threads and read one. Replace `<id>` with the `id` of your thread:

```bash [commands/read-thread]
pnpm vitehub comments list --json
pnpm vitehub comments get --input '{"id":"<id>"}'
```

On a deployed app, the Comments section of the [Console](/docs/console) shows the same threads. It shows only the threads that `authorize` lets you read. Click a row to read the thread, reply, or resolve it.

::details{summary="What the Comments section of the Console does"}
The list comes from `comments.list` with your sign-in, so it shows only the threads that `authorize` lets you read. Use the chips to filter by open, resolved, mine, or mentions. A page thread links to `<page>?comment=<n>`.

Click a row to open the thread in a side panel. There you read every message, reply, resolve or reopen the thread, and edit or delete your own messages. Type `@` in the reply box to mention someone. The menu finds people with `comments.users`, and a mention shows as a chip. Each change runs the same operation with your sign-in, so `authorize` decides it. When it lets you read but not write, the panel has no reply box. The URL holds the open thread as `?thread=<id>`, so you can share the link. *Open page* in the panel opens the thread on its page.
::

### In `vite dev`

You can try comments without sign-in in `vite dev`. Set `console: { auth: false }`, or leave out the `console` option. When nobody is signed in, `vite dev` then runs every action as the user `{ id: 'local', name: 'You' }`. `authorize` sees that user, and your new comments have it as author.

A production build never does this. There, a call without sign-in has no user. The policy above refuses it with `COMMENTS_R0009`.

## Use it in the browser

Create a client to read and write comments from your pages:

```ts [app/comments.ts]
import { createCommentsClient, createRestTransport } from 'vite-hub/comments/client'

export const comments = createCommentsClient({
  transport: createRestTransport(),
  user: { id: 'ana', name: 'Ana Ruiz' },
  query: { page: location.pathname },
})
```

- `createRestTransport()` sends each call to the [Comments API](/docs/comments/server-api#rest-transport) of your app, with the sign-in of the user. `authorize` decides each call.
- `query` picks the threads to load. Here, the threads of the current page.

## The overlay

The same `server/comments.ts` also runs the overlay. The overlay lets people comment on any spot of a page.

The overlay does not use the `local` user of `vite dev`. Without sign-in, `authorize` gets `user: null`, like a guest. The policy above refuses guests, so the overlay does not show. To try it on your computer, replace `server/comments.ts` with this version, which lets guests in while you test:

```ts [local-test/server/comments.ts]
import { defineComments } from 'vite-hub/comments'

export default defineComments({
  authorize: ({ user, action }) => {
    // Local test only: guests read and write.
    if (!user) return action !== 'delete'
    return action !== 'delete' || user.role === 'admin'
  },
})
```

Your app also needs a page, such as an `index.html` with a heading. Restart the dev server after you add it.

1. Open the page with `?vitehub` at the end of the URL, such as `http://localhost:3000/?vitehub`. A pill named **Comments** shows at the bottom of the page.
2. Select **Comments**. The pill becomes the Comments toolbar, and the thread list opens.
3. Press `C`. As a guest, type your name, and select **Comment**.
4. Click a spot, write, and press <kbd>Enter</kbd>.

The overlay uses the [Comments API](/docs/comments/server-api#http-routes). It runs the same actions and the same `authorize` for the user of the request. To leave the overlay out, set `vitehub({ comments: { overlay: false } })`. The API and the CLI still work. See [Turn comment mode on and off](/docs/comments/configure#turn-comment-mode-on-and-off).

Guests and share-link readers use the same `createRestTransport()`. See [REST transport](/docs/comments/server-api#rest-transport).

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/comments/operations/configure"}
See every option of comment operations.
:::

:::card{title="Server API" icon="i-lucide-code-2" to="/docs/comments/operations/server-api"}
Create and read threads from your server code.
:::

:::card{title="UI parts" icon="i-lucide-message-square" to="/docs/ui/comments"}
Build a comment UI with ready Vue parts.
:::
::
