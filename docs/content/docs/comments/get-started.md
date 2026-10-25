---
title: Add comments to an app
description: Define who may comment, create the tables, and read the first thread from the CLI.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

## Turn on the Database

Comments live in your Database. Enable it, and add the Console so you can see the threads:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ database: true, console: { auth: 'app' } }),
    nitro(),
  ],
})
```

Without a Database the build fails with `COMMENTS_B0001` and tells you to set `database: true`.

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

Open the Console at `/_vitehub` and choose **Comments** to see the same threads. A page thread links to `<page>?comment=<n>`.

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
