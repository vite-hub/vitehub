---
title: Publish your first CMS post
description: Select the cms preset in server/content.ts, create its tables, then write and publish a post from the terminal.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A CMS lets you write and publish content, such as blog posts, from an editor in your app. ViteHub's CMS keeps each post as a Markdown file and saves every draft.

In this tutorial, you add a `posts` collection, draft a post with the `vitehub` CLI, and publish it. You set up no storage and no database schema yourself. In production, editors use the Console at [console.vitehub.dev](https://console.vitehub.dev).

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation) and run commands from the app root. Everything runs on your machine with no account or API key.

::tutorial-step{title="Install and turn on ViteHub"}
## Install and turn on ViteHub

Install the CMS along with the Content, Database, and Workspace packages it uses:

```bash pm [commands/install]
pnpm add @vite-hub/cms @vite-hub/content @vite-hub/database @vite-hub/workspace drizzle-orm@1.0.0-rc.6 zod
pnpm add -D drizzle-kit@1.0.0-rc.6
```

Add `console: { auth: false }` to your ViteHub options in `nuxt.config.ts` or `vite.config.ts`:

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { console: { auth: false } },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ console: { auth: false } }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ console: { auth: false } })],
})
```
::::
:::

`console: { auth: false }` turns on the local [Console](/docs/console) endpoint without signed calls, so the `vitehub` CLI can talk to your dev server. Use it only on your own machine.

::

::tutorial-step{title="Define the collections"}
## Define the collections

A collection is a group of documents of the same kind. Create `server/content.ts` with a `posts` collection:

```ts [server/content.ts]
import { defineContent } from 'vite-hub/content'
import { documents } from 'vite-hub/content/collections'
import { cms } from 'vite-hub/cms'
import { z } from 'zod'

export default defineContent({
  extends: cms,
  collections: {
    posts: documents({ path: 'posts/**/*.md', fields: { title: z.string(), date: z.coerce.date() } }),
  },
  // Local only: anyone may read drafts, write, and publish.
  authorize: () => true,
})
```

- `extends: cms` makes this content a CMS. `vitehub()` then turns on `workspace`, `database`, and `blob` for you. Do not set `workspace` yourself.
- `posts` stores Markdown files under `posts/` and requires a `title` and `date` on each post.
- `authorize` controls who can read `/api/content/**`, read drafts, write, and publish. Without it, access is denied. Here it lets everyone in, because the dev server has no signed-in user with `auth: false`. For production, see [Access](/docs/cms/configure#access).

::

::tutorial-step{title="Create the tables"}
## Create the tables

Create the database tables that keep the drafts and their revision history:

```bash [commands/migrate]
pnpm vitehub database generate
pnpm vitehub database migrate
```

- `database generate` writes a migration file to `server/databases/default/migrations/`. A migration is a file that creates or changes tables.
- `database migrate` creates the tables in your local SQLite file at `.vitehub/data/database/sqlite.db`.

Because you did not define a database, ViteHub uses one named `default`. To set it up yourself, see [Take over the Database](/docs/cms/configure#take-over-the-database).

::

::tutorial-step{title="Write and publish a post"}
## Write and publish a post

Start the dev server:

```bash [commands/start]
pnpm dev
```

Keep the server running. Open a second terminal and create `hello-world.md` with the post:

```md [hello-world.md]
---
title: Hello world
date: 2026-01-31
---

My first post.
```

Because `date` is a required field, a post without a date cannot be published. Save the file as a draft, then publish it:

```bash [commands/publish]
pnpm vitehub content edit posts hello-world --file ./hello-world.md
pnpm vitehub content publish --collection posts --id hello-world
```

`publish` lists the draft and asks you to confirm. Check the post's state, then read it as a visitor does:

```bash [commands/status]
pnpm vitehub content status posts
curl http://localhost:3000/api/content/get/posts/hello-world
```

`status` shows the post as `published`:

```text [output/status.txt]
published  posts/hello-world
```

The `curl` request returns the post as JSON with `title` and `date` in `data`. Visitors only see published posts, so any draft you save without publishing stays hidden.

In production, editors write and publish in the Console editor. The [Console editor](/docs/content/console) page shows every task in it, and [Content CLI](/docs/content/cli) shows every command.

::

## Next steps

::card-group
:::card{title="Access" icon="i-lucide-shield" to="/docs/cms/configure#access"}
Choose who can edit and publish in production.
:::

:::card{title="GitHub store" icon="i-lucide-github" to="/docs/cms/configure#github-store"}
Store your posts in a GitHub repository.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/cms/hosts"}
Deploy the app and create its resources.
:::
::
