---
title: Comment on your first page
description: Add Comments to a Vite app with one plugin, pin a comment, let your team sign in with GitHub, and deploy it on Node.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You add comments to the pages of a Vite app. At the end, you pin a comment on a page, your team signs in with GitHub to comment, and the app runs on a Node.js server.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.
- for the last two steps: a GitHub repository for the app, and a GitHub account that can create a GitHub App

You do not need a ViteHub app, a database server, or a sign-in system of your own.

::tutorial-step{title="Turn on Comments"}
## Turn on Comments

Install the Comments package:

```bash [commands/install]
pnpm add @vite-hub/comments
```

Add the `comments()` plugin to `vite.config.ts`. `vue()` is the plugin of the example app. Keep the plugins of your own app.

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import comments from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), comments()],
})
```

You do not set up anything else. If your app has no server, `comments()` adds [Nitro](https://nitro.build) as its server. Then it adds these parts:

- the Comments API at `/api/_vitehub/comments/`
- the overlay script, which draws the comment tools on top of your pages
- a SQLite database file for the comments, `.vitehub/data/comments.sqlite`

Comments opens the SQLite file with `node:sqlite`, which is part of Node.js, and creates its tables. You do not install a database driver or run a migration. The plugin also adds a `.gitignore` file next to the database file, so the comments that you write on your computer stay out of Git.

::

::tutorial-step{title="Pin a comment"}
## Pin a comment

Start the dev server:

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/?vitehub`. `?vitehub` at the end of the URL turns on the ViteHub page tools. A small bar, the pill, shows at the bottom of the page, with the Comments toolbar in it. The server also sets the `vitehub-tools` cookie, so the other pages of the site stay in comment mode. To leave comment mode, select **×** in the pill.

1. Press <kbd>C</kbd>, or select **Comment** in the toolbar. As a guest, type your name first. The browser keeps it for the next pages.
2. Click a heading on the page. A comment box opens at that point.
3. Type a comment, and press <kbd>Enter</kbd>. A numbered pin shows where you clicked.
4. Select the pin, write a reply, and send it.
5. Type `@` in a reply. The list shows the people that you may mention there. As a guest it is empty: nobody can mention a guest. After your team signs in, in the next step, `@` suggests the people who commented before, and the server checks each mention.
6. Select **Resolve**, the check mark on the thread. The pin goes away. Open the thread list from the toolbar and select **Resolved** to see it again.

Make the window smaller or larger. The pin stays on the heading, because Comments saves its position relative to the heading, not to the window. Then stop the dev server and start it again. The thread is still there. This proves that Comments saved it in the SQLite file.

> [!NOTE]
> On the dev server, anyone can comment as a guest, with a name that they type. A production build lets in only the people that you choose. The next step lets in everyone who can push to the repository.

::

::tutorial-step{title="Let your team sign in with GitHub"}
## Let your team sign in with GitHub

Comments uses a GitHub App to sign people in. Then anyone who can push to the app's repository can comment. Other people see a message that tells them why they cannot.

Create the GitHub App:

1. On GitHub, open **Settings**, **Developer settings**, **GitHub Apps**, then **New GitHub App**.
2. Set **Callback URL** to `http://localhost:5173/api/_vitehub/comments/auth/callback/github`. Also add `http://localhost:3000/api/_vitehub/comments/auth/callback/github` for the production server below, and the URL of each deployed site, such as `https://staging.example.com/api/_vitehub/comments/auth/callback/github`. A GitHub App takes up to 10.
3. Under **Identifying and authorizing users**, turn off **Expire user authorization tokens**. Under **Webhook**, turn off **Active**. Leave the permissions as they are, then create the App.
4. Copy the **Client ID**, and select **Generate a new client secret**.
5. Select **Install App**, and install it on the app's repository.

Put three variables in a `.env` file. The server reads them when it starts.

- `VITEHUB_GITHUB_CLIENT_ID` and `VITEHUB_GITHUB_CLIENT_SECRET` are the values from step 4.
- `VITEHUB_SECRET` encrypts the session cookies. It must have 32 or more characters, and it must be the same on every server. The command `openssl rand -base64 32` makes one.

```bash [.env]
VITEHUB_GITHUB_CLIENT_ID=Iv23li...
VITEHUB_GITHUB_CLIENT_SECRET=...
VITEHUB_SECRET=   # openssl rand -base64 32
```

Comments also needs the name of the repository. When you build, it reads the `origin` remote of your Git folder, or the variables of your CI or host. See [Sign in with GitHub](/docs/comments/configure#sign-in-with-github) for the variables that it reads.

::

::tutorial-step{title="Deploy on Node"}
## Deploy on Node

A production build keeps comments in a database that you choose. On a Node.js server, a SQLite file is the easiest. Set the `database` option:

```ts [node/vite.config.ts]
export default defineConfig({
  plugins: [vue(), comments({ database: 'file:./data/comments.sqlite' })],
})
```

The path starts from the folder where you start the server. For a Turso database or Cloudflare D1, see [Choose the Database](/docs/comments/configure#choose-the-database).

Build the app and start the server. `--env-file=.env` loads the variables from the last step:

```bash [commands/deploy]
pnpm vite build
node --env-file=.env .output/server/index.mjs
```

Open `http://localhost:3000/?vitehub`.

1. A message at the bottom of the page asks you to sign in. Select **Sign in with GitHub**.
2. Allow the App on GitHub. GitHub sends you back to the page in comment mode.
3. Pin a comment. It shows your GitHub name and picture.
4. Select your picture in the toolbar to sign out.

This proves that GitHub sign-in works in the production build. The session is an encrypted cookie that lasts 7 days, so the server keeps no users and no sessions. Every 5 minutes, Comments asks GitHub again if each person can still push.

> [!NOTE]
> On a server, keep `data/comments.sqlite` on a disk that a new deploy does not delete, such as a Docker volume. Cloudflare Workers, Vercel, and Netlify have no such disk. On these hosts, keep comments in [D1 or a Turso database](/docs/comments/configure#choose-the-database). See [Hosts](/docs/comments/hosts).

::

## Next steps

- [Add presence and edits with ViteHub](/docs/comments/with-vite-hub): see the cursors of other people, and edit page text in place.
- [Configure](/docs/comments/configure): choose who can comment, and set up mentions, notifications, and comments on the pull request of a preview.
- [Hosts](/docs/comments/hosts): see what each host supports.
