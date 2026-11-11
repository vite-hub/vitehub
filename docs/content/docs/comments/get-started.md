---
title: Comment on your first page
description: Add Comments to a Vite app with one plugin, pin a comment, let your team sign in with GitHub, and deploy it on Node.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Comments lets your team pin comments on the pages of your site, like notes on a design file. People click a spot on the page, write a comment, and reply to each other.

In this tutorial, you add Comments to a Vite app and pin a comment on a page. Then you let your team sign in with GitHub, and you run the app on a Node server.

> [!NOTE] Before you start
> You need Node.js 22.22 or newer, pnpm, and a Vite app with a page to comment on, such as an `index.html` with a heading. Run the commands in the root folder of the app. You do not need a ViteHub app, a database, or a login of your own.
>
> Does your app use `vitehub()`, like the app from [Installation](/docs/getting-started/installation)? Then follow [With ViteHub](/docs/comments/with-vite-hub) instead. The `comments()` plugin does not work next to `vitehub()`.
>
> The last two steps also need a GitHub repository for the app, and a GitHub account that can create a GitHub App.

::tutorial-step{title="Turn on Comments"}
## Turn on Comments

Add Comments and Drizzle to your app. Comments uses the `drizzle-orm` of your app:

```bash pm [commands/install]
pnpm add @vite-hub/comments drizzle-orm@1.0.0-rc.5 valibot
```

Add the `comments()` plugin to `vite.config.ts`. Keep the other plugins of your app. This example app uses Vue, but `comments()` does not need Vue.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import comments from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), comments()],
})
```

You do not set up anything else. `comments()` adds a server to your app, [Nitro](https://nitro.build), if the app does not have one. Then it adds:

- The Comments API at `/api/_vitehub/comments/`.
- The script that shows comments on your pages.
- A SQLite database file for the comments, `.vitehub/data/comments.sqlite`. Comments makes its tables for you. Git ignores this file, so the comments that you write on your computer stay out of your repository.

::

::tutorial-step{title="Pin a comment"}
## Pin a comment

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/?vitehub`. The `?vitehub` part turns on the ViteHub page tools, such as Comments. A pill named **Comments** shows at the bottom of the page. Select it. The pill becomes the Comments toolbar, and the thread list opens. Other pages of the site stay in comment mode until you select **×** in the pill.

1. Press <kbd>C</kbd>, or select **Comments** in the toolbar. The button says **Click anywhere** while comment mode is on. As a guest, type your name first, and select **Comment**. The browser keeps the name for the next pages.
2. Click a heading on the page. A comment box opens at that point.
3. Type a comment, and press <kbd>Enter</kbd>. A numbered pin shows where you clicked.
4. Select the pin, write a reply, and send it.
5. Type `@` in a reply. The list shows the people that you can mention. As a guest, the list is empty, because nobody can mention a guest. When your team signs in, in the next step, `@` suggests the people who commented before. The server checks each mention.
6. Select **Resolve**, the check mark on the thread. The pin goes away. To see it again, select **All comments** in the toolbar and then **Resolved**.

On the dev server, anyone can comment as a guest with a name that they type. A production build lets in only the people that you choose. The next step lets in everyone who can push to the repository.

Now resize the window. The pin stays on the heading, because Comments saves it next to the heading, not at a point in the window. Stop the dev server and start it again. The thread is still there, in the SQLite file.

::

::tutorial-step{title="Let your team sign in with GitHub"}
## Let your team sign in with GitHub

Comments signs people in with a GitHub App. Then anyone who can push to the repository of the app can comment. Other people see why they cannot.

1. On GitHub, open **Settings**, **Developer settings**, **GitHub Apps**, then **New GitHub App**.
2. Set **Callback URL** to `http://localhost:5173/api/_vitehub/comments/auth/callback/github`. Also add `http://localhost:3000/api/_vitehub/comments/auth/callback/github` for the production server in the next step. Add the URL of each deployed site too, such as `https://staging.example.com/api/_vitehub/comments/auth/callback/github`. A GitHub App takes up to 10 callback URLs.
3. Under **Identifying and authorizing users**, turn off **Expire user authorization tokens**. Under **Webhook**, turn off **Active**. Do not change the permissions. Create the App.
4. Copy the **Client ID**. Then select **Generate a new client secret**, and copy the secret.
5. Select **Install App**, and install it on the repository of the app.

Put the three values in `.env`:

```bash [.env]
VITEHUB_GITHUB_CLIENT_ID=Iv23li...
VITEHUB_GITHUB_CLIENT_SECRET=...
VITEHUB_SECRET=   # openssl rand -base64 32
```

- `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET` are the values from the GitHub App.
- `VITEHUB_SECRET` encrypts the session cookies. Make it at least 32 characters long, and use the same value on every server.

Comments also must know the repository. When you build, it reads the `origin` remote of your Git folder, or a variable from your CI or host. [Sign in with GitHub](/docs/comments/configure#sign-in-with-github) lists the variables.

::

::tutorial-step{title="Deploy on Node"}
## Deploy on Node

A production build keeps comments in a database that you choose. On Node, the simplest choice is a SQLite file. Set `database` in `vite.config.ts`:

```ts [node/vite.config.ts]
import vue from '@vitejs/plugin-vue'
import comments from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), comments({ database: 'file:./data/comments.sqlite' })],
})
```

The path starts from the folder where you start the server. To use Turso or Cloudflare D1, see [Choose the Database](/docs/comments/configure#choose-the-database).

Build the app and start the server:

```bash [commands/deploy]
pnpm vite build
node --env-file=.env .output/server/index.mjs
```

Open `http://localhost:3000/?vitehub`.

1. A message at the bottom of the page asks you to sign in. Select **Sign in with GitHub**.
2. Allow the App on GitHub. GitHub sends you back to the page, in comment mode.
3. Pin a comment. It shows your GitHub name and picture.
4. To sign out, select your picture in the toolbar.

The session is an encrypted cookie that lasts 7 days, so the server keeps no users and no sessions. Every 5 minutes, Comments asks GitHub again if each person can still push.

::

## What happens when you deploy

On a server, keep `data/comments.sqlite` on a disk that survives a deploy, such as a Docker volume. Cloudflare Workers, Vercel, and Netlify have no such disk. On these hosts, keep comments in [D1 or a Turso database](/docs/comments/configure#choose-the-database). [Hosts](/docs/comments/hosts) shows what each host supports.

## Next steps

::card-group
:::card{title="Add presence and edits" icon="i-lucide-users" to="/docs/comments/with-vite-hub"}
See the cursors of your team, and edit Content text on the page.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/comments/configure"}
Choose who can comment, tell people when they are mentioned, and post threads to pull requests.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/comments/hosts"}
See what each host supports.
:::
::
