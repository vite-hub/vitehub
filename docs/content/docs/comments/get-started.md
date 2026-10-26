---
title: Comment on your first page
description: Add Comments to a Vite app with one plugin, pin a comment, let your team sign in with GitHub, and deploy it on Node.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Add Comments to a Vite app with one plugin, and pin a comment on a page. Then let your team sign in with GitHub, and deploy the app on Node. You need no ViteHub app, no Database, and no login of your own.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. The last two steps also need a GitHub repository for the app, and a GitHub account that can create a GitHub App.

::tutorial-step{title="Turn on Comments"}
## Turn on Comments

```bash [commands/install]
pnpm add @vite-hub/comments
```

Add the `comments()` plugin:

```ts [vite.config.ts]
import vue from '@vitejs/plugin-vue'
import comments from '@vite-hub/comments/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), comments()],
})
```

There is nothing else to set up. `comments()` adds [Nitro](https://nitro.build) as the app's server, unless the app has it already, and adds these parts to it:

- The Comments API at `/api/_vitehub/comments/`.
- The overlay script, which pages load in comment mode.
- A SQLite file for the threads, `.vitehub/data/comments.sqlite`. Comments opens it with Node's built-in `node:sqlite` and creates its tables, so there is no driver to install and no migration to run. The plugin adds a `.gitignore` next to it, so the threads you write on your computer stay out of Git.

::

::tutorial-step{title="Pin a comment"}
## Pin a comment

```bash [commands/start]
pnpm vite dev
```

Open `http://localhost:5173/?comments`. The `?comments` query turns on comment mode, and a toolbar shows at the bottom of the page. The server also sets the `vitehub-comments` cookie, so other pages of the site keep comment mode until you close the toolbar.

1. Press <kbd>C</kbd>, or select **Comment** in the toolbar.
2. Click a heading on the page. A comment box opens at that point.
3. Type your name, then a comment, and press <kbd>⌘</kbd> <kbd>Enter</kbd>. A numbered pin shows where you clicked.
4. Select the pin, write a reply, and send it.
5. Select **Resolve**, the check mark on the thread. The pin goes away. Open the thread list from the toolbar and select **Show resolved** to see it again.

On the dev server, anyone may comment as a guest under a name they type. A production build lets nobody in until you choose who may comment. That is the next step.

Resize the window. The pin stays on the heading, because it is stored relative to the element, not to the window. Stop the dev server and start it again: the thread is still there, in the SQLite file.

::

::tutorial-step{title="Let your team sign in with GitHub"}
## Let your team sign in with GitHub

Comments signs people in with a GitHub App. Anyone who can push to the app's repository may then comment. Other people see why they cannot.

1. On GitHub, open **Settings**, **Developer settings**, **GitHub Apps**, then **New GitHub App**.
2. Set **Callback URL** to `http://localhost:3000/api/_vitehub/comments/auth/callback/github`. Add the URL of each site that people will comment on, such as `https://staging.example.com/api/_vitehub/comments/auth/callback/github`. A GitHub App takes up to 10.
3. Under **Identifying and authorizing users**, turn off **Expire user authorization tokens**. Under **Webhook**, turn off **Active**. Leave the permissions as they are, then create the App.
4. Copy the **Client ID**, and select **Generate a new client secret**.
5. Select **Install App**, and install it on the app's repository.

Comments reads three server variables. `VITEHUB_SECRET` encrypts the session cookies. It must be at least 32 characters, and the same on every server.

```bash [.env]
VITEHUB_GITHUB_CLIENT_ID=Iv23li...
VITEHUB_GITHUB_CLIENT_SECRET=...
VITEHUB_SECRET=   # openssl rand -base64 32
```

Comments also needs to know the repository. It reads it from the `origin` remote of the Git checkout when you build, or from your CI or host. See [Sign in with GitHub](/docs/comments/configure#sign-in-with-github) for the variables it reads.

::

::tutorial-step{title="Deploy on Node"}
## Deploy on Node

A production build needs to know where the threads go, because only you know which disk keeps its files. Give `comments()` a SQLite file:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vue(), comments({ database: 'file:./data/comments.sqlite' })],
})
```

The path is relative to the directory that the server starts in. Build the app and start the server:

```bash [commands/deploy]
pnpm vite build
node --env-file=.env .output/server/index.mjs
```

Open `http://localhost:3000/?comments`.

1. A message at the bottom of the page asks you to sign in. Select **Sign in with GitHub**.
2. Allow the App on GitHub. GitHub sends you back to the page in comment mode.
3. Pin a comment. It shows your GitHub name and picture.
4. Select your picture in the toolbar to sign out.

The session is an encrypted cookie that lasts 7 days, so the server stores no users and no sessions. Comments asks GitHub again every 5 minutes whether each person can still push.

On a server, keep `data/comments.sqlite` on a disk that survives deploys, such as a Docker volume. On Cloudflare Workers, keep the threads in [D1](/docs/comments/configure#cloudflare-d1) instead. Vercel and Netlify have no such disk, so they need a [ViteHub Database](/docs/comments/with-vite-hub). See [Hosts](/docs/comments/hosts).

::

## Next steps

- [Add presence and edits with ViteHub](/docs/comments/with-vite-hub): see each other's cursors, and edit Content text in place.
- [Configure](/docs/comments/configure): who may comment, mentions, notifications, and posting threads to the pull request of a preview.
- [Hosts](/docs/comments/hosts): what each host supports.
