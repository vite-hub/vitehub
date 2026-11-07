---
title: Publish your first CMS post
description: Select the cms preset in server/content.ts, create its tables, then write and publish a post in the Console editor.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You add blog posts to a Vite app. You write a post in the Console, the ViteHub admin page in your browser, and you publish it. At the end, `curl` reads the published post from your app's API.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.

You do not need a cloud account or a database server. You also do not write database tables yourself.

::tutorial-step{title="Install and turn on ViteHub"}
## Install and turn on ViteHub

Install the packages:

```bash [commands/install]
pnpm add vite-hub @vite-hub/cms @vite-hub/content @vite-hub/database @vite-hub/workspace drizzle-orm zod
pnpm add -D drizzle-kit
```

- `vite-hub` and `@vite-hub/cms` give you the CMS.
- `@vite-hub/content` reads and writes your documents.
- `@vite-hub/database` keeps the history of each document and the editor sessions. `drizzle-orm` and `drizzle-kit` are the tools that create and read its tables.
- `@vite-hub/workspace` stores the document files.
- `zod` checks the fields of each post, such as the title.

Add `vitehub()` to the Vite config:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ preset: 'node', console: { auth: false } })],
})
```

- `preset: 'node'` tells ViteHub that the app runs on a Node.js server.
- `console: { auth: false }` turns on the [Console](/docs/development/console) with no sign-in. Anyone who can reach the dev server can use it, so use this only on your own computer.

::

::tutorial-step{title="Describe the posts"}
## Describe the posts

Create `server/content.ts`. A collection is a group of documents of the same kind. This file makes one collection, `posts`:

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

- `extends: cms` uses the `cms` preset. A preset is a ready-made setup. This one turns on Workspace, Database, and Blob for you, unless you set them yourself in `vitehub()`. It also sets `workspace`, so do not add `workspace` here.
- `documents()` makes a collection of Markdown files. `path` says which files belong to it. `fields` lists the fields of each post: a `title` text and a `date`.
- `authorize` decides who can read drafts, write, and publish, in the Console editor and through the [Content Agent capability](/docs/content/agent-capability). Without `authorize`, nobody can. This one allows everyone, because with `auth: false` the Console has no signed-in user.

> [!NOTE]
> Before you put the app online, replace `authorize: () => true` with a real rule. See [Access](/docs/cms/configure#access).

::

::tutorial-step{title="Create the tables"}
## Create the tables

```bash [commands/migrate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

- `db generate` writes a migration to `server/databases/migrations/`. A migration is a file with the steps that create tables. This one creates the five `workspace_history_*` tables and one table for editor sessions.
- `db migrate` runs the migration on your local database. By default, the database is the file `.vitehub/data/database/sqlite.db`.

Your app does not define a database of its own, for example in `server/databases/config.ts`, so the CMS adds one with the name `default`. To set it up yourself, see [Take over the Database](/docs/cms/configure#take-over-the-database).

::

::tutorial-step{title="Write and publish a post"}
## Write and publish a post

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/_vitehub/content`. If your app uses another port, change `5173`. You see the Content section of the Console, with the `posts` collection.

1. Select **New** next to **posts**, and type a title. The id follows the title.
2. Select **Create**. The post is a draft now.
3. Write some text in the body. Drafts save one second after typing stops.
4. Select **Publish**.

Keep the server running. In another terminal, check the state of the post. Then read it as a visitor does. Replace `<id>` with the id of your post:

```bash [commands/status]
pnpm vitehub content status posts
curl http://localhost:5173/api/content/get/posts/<id>
```

`status` shows the post as `published`. The `curl` command returns the post. This proves that the post is published. `/api/content/**` sends only published documents. A change that you save but do not publish does not show in the response.

::

## Next steps

- [Console editor](/docs/content/console): learn every task in the editor.
- [Access](/docs/cms/configure#access): choose who can edit and publish.
- [GitHub store](/docs/cms/configure#github-store): keep the posts in a GitHub repository.
- [Hosts](/docs/cms/hosts): deploy the app.
