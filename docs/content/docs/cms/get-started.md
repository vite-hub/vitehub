---
title: Publish your first CMS post
description: Select the cms preset in server/content.ts, create its tables, then write and publish a post in the Console editor.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Add a `posts` collection to a Vite app with the `cms` preset. Create its tables, write a post in the Console, and publish it. You write no Workspace, no Database Definition, and no schema.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root.

::tutorial-step{title="Install and turn on ViteHub"}
## Install and turn on ViteHub

The `cms` preset uses Content, Database, and Workspace, so install their packages too.

```bash [commands/install]
pnpm add vite-hub @vite-hub/cms @vite-hub/content @vite-hub/database @vite-hub/workspace drizzle-orm zod
pnpm add -D drizzle-kit
```

Add `vitehub()` to the Vite config. The preset needs no feature settings. `console: { auth: false }` turns on the [Console](/docs/development/console) for anyone who can reach the dev server. Use it only on your own machine.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: { auth: false } })],
})
```

::

::tutorial-step{title="Define the collections"}
## Define the collections

```ts [server/content.ts]
import { defineContent, documents } from 'vite-hub/content'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export const content = defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string(), date: z.coerce.date() } }),
  },
  // Local only: anyone may read drafts, write, and publish.
  authorize: () => true,
})
```

When `server/content.ts` selects the preset, `vitehub()` turns on `workspace`, `database`, and `blob` if you left them unset. The preset sets `workspace`, so do not pass it.

`authorize` decides who may read drafts, write, and publish in the Console editor and the [Content Agent Capability](/docs/content/agent-capability). Without it, nobody can. This policy allows everyone, because the Console has no signed-in user with `auth: false`. See [Access](/docs/cms/configure#access) for a policy for production.

::

::tutorial-step{title="Create the tables"}
## Create the tables

```bash [commands/migrate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

`db generate` writes a migration with the five `workspace_history_*` tables and the editor sessions table to `server/databases/migrations/`. `db migrate` applies it to the local Database, `.vitehub/data/database/sqlite.db` by default.

The app has no Database Definition, so the preset adds the `default` Database. To configure it yourself, see [Take over the Database](/docs/cms/configure#take-over-the-database).

::

::tutorial-step{title="Write and publish a post"}
## Write and publish a post

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/_vitehub/content`, using your app's actual origin and port. The Content section of the Console lists the `posts` collection.

1. Select **New** next to **posts**, and type a title. The id follows the title.
2. Select **Create**. The post is a draft now.
3. Write some text in the body. Drafts save one second after typing stops.
4. Select **Publish**.

Keep the server running. In another terminal, check the state of the post, then read it as a visitor does:

```bash [commands/status]
pnpm vitehub content status posts
curl http://localhost:5173/api/content/posts/<id>
```

`status` shows the post as `published`. `/api/content/**` serves only published documents, so a change that you save but do not publish stays out of the response.

The [Console editor](/docs/content/console) page describes every task in the editor. Next, choose [who may edit and publish](/docs/cms/configure#access), keep the posts [in a GitHub repository](/docs/cms/configure#github-store), or [deploy the app](/docs/cms/hosts).

::
