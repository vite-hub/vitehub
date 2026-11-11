---
title: Publish your first CMS post
description: Select the cms preset in server/content.ts, create its tables, then write and publish a post in the Console editor.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A CMS lets you write and publish content, such as blog posts, from an editor in your app. ViteHub's CMS keeps each post as a Markdown file and saves every draft.

In this tutorial, you add a `posts` collection, write a post in the Console, and publish it. The Console is the ViteHub admin app at [console.vitehub.dev](https://console.vitehub.dev). It calls your app. You set up no storage and no database schema yourself.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). Run the commands from the root of the app. You need no account and no API key. Everything runs on your computer.

::tutorial-step{title="Install and turn on ViteHub"}
## Install and turn on ViteHub

Install the CMS. The CMS uses the Content, Database, and Workspace packages, so install them too.

```bash pm [commands/install]
pnpm add @vite-hub/cms @vite-hub/content @vite-hub/database @vite-hub/workspace drizzle-orm zod
pnpm add -D drizzle-kit
```

Add `console: { auth: false }` to `vitehub()` in `vite.config.ts`:

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

`console: { auth: false }` turns on the [Console](/docs/development/console) endpoint with no sign-in. On the dev server, the hosted Console can call it without a token. Use it only on your own computer.

::

::tutorial-step{title="Define the collections"}
## Define the collections

A collection is a group of documents of the same kind. Create `server/content.ts` and add a `posts` collection:

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
- `posts` keeps each post as a Markdown file under `posts/`. Each post has a `title` and a `date`.
- `authorize` decides who may read drafts, write, and publish. Without it, nobody can. Here it lets everyone in, because the Console has no signed-in user with `auth: false`. For production, see [Access](/docs/cms/configure#access).

::

::tutorial-step{title="Create the tables"}
## Create the tables

Create the database tables that keep the drafts and their history:

```bash [commands/migrate]
pnpm vitehub database generate
pnpm vitehub database migrate
```

- `database generate` writes a migration file to `server/databases/default/migrations/`. A migration is a file that creates or changes tables.
- `database migrate` creates the tables in the local database file, `.vitehub/data/database/sqlite.db`.

You did not define a database, so ViteHub uses one named `default`. To set it up yourself, see [Take over the Database](/docs/cms/configure#take-over-the-database).

::

::tutorial-step{title="Write and publish a post"}
## Write and publish a post

Start the dev server:

```bash [commands/start]
pnpm dev
```

The dev server prints a link that opens the app in the [Console](/docs/development/console#in-development), such as `https://console.vitehub.dev/open?project=http%3A%2F%2Flocalhost%3A3000`. Open it, select **Continue**, then **Content**. The Console shows the `posts` collection.

1. Select **Posts**, then **New**. Type a title. The id follows the title.
2. Pick a date. `date` is a field of the collection, so a post without a date cannot be published.
3. Select **Create**. The post is a draft now.
4. Write some text in the body. Drafts save one second after typing stops.
5. Select **Publish**.

Keep the server running. Open a second terminal. Check the state of the post, then read it as a visitor does. Replace `<id>` with the id of your post:

```bash [commands/status]
pnpm vitehub content status posts
curl http://localhost:3000/api/content/get/posts/<id>
```

`status` shows the post as `published`:

```text [output/status.txt]
published  posts/hello-world
```

The `curl` request returns the post as JSON, with its `title` and `date` in `data`. Visitors see only published posts. A change that you save but do not publish stays hidden.

The [Console editor](/docs/content/console) page shows every task in the editor.

::

## Next steps

::card-group
:::card{title="Access" icon="i-lucide-shield" to="/docs/cms/configure#access"}
Choose who may edit and publish in production.
:::

:::card{title="GitHub store" icon="i-lucide-github" to="/docs/cms/configure#github-store"}
Keep the posts in a GitHub repository.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/cms/hosts"}
Deploy the app and create its resources.
:::
::
