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
