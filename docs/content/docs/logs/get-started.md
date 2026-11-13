---
title: Capture your first log event
navigation.title: Get started
navigation.order: 2
description: "Install Evlog, turn on local capture in vitehub(), add fields to one request event, and inspect the event in the Console."
layout: tutorial
icon: i-lucide-logs
---

Logs shows what your server did on each request. ViteHub uses [Evlog](https://evlog.dev), a logging library, to write one log event for each request. You add your own data to that event, and you read it in the Console.

In this tutorial, you add data to the log event of one API route. Then you call the route and read its event in the Console.

> [!NOTE] Before you start
> Use a Vite app with Nitro 3, such as the app from [Installation](/docs/getting-started/installation). You need no account and no API key. Everything runs on your computer.

::tutorial-step{title="Install Evlog"}

Add Evlog to your app:

```bash pm [commands/install]
pnpm add evlog
```

::

::tutorial-step{title="Enable local capture"}

Add `observability.logs` and `console` to the ViteHub options of your app. Keep the other options of your app. In Vite, `vitehub()` includes Nitro. In a Nitro app, keep `nitro()` after `vitehub()`.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
const isDev = process.env.NODE_ENV === 'development'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', observability: { logs: true }, console: isDev ? { auth: false } : false },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    plugins: [
      vitehub({ host: 'node', observability: { logs: true }, console: isDev ? { auth: false } : false }),
      nitro(),
    ],
  }
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig(({ command }) => {
  const isDev = command === 'serve'

  return {
    plugins: [
      vitehub({ host: 'node', observability: { logs: true }, console: isDev ? { auth: false } : false }),
    ],
  }
})
```
::::
:::

- `observability: { logs: true }` saves the log events on your computer while the dev server runs.
- `auth: false` lets you open the Console with no sign-in while the dev server runs. These configs disable the Console in production. See [Console](/docs/development/console) before you deploy.

::

::tutorial-step{title="Add request data"}

Create `server/api/status.get.ts`. It adds a message and the environment name to the log event of the request:

```ts [server/api/status.get.ts]
import { useLogger } from 'evlog/nitro/v3'
import { defineHandler } from 'nitro/h3'

export default defineHandler((event) => {
  useLogger(event).set({ message: 'Status checked', deployment: { environment: 'development' } })
  return { ok: true }
})
```

- `useLogger(event)` gets the log event of this request. Evlog makes it for you.
- `.set()` adds your fields to that event.

::

::tutorial-step{title="Inspect the request"}

Start the dev server:

```sh [commands/start]
pnpm dev
```

1. Open `http://localhost:3000/api/status` in your browser. It shows `{"ok":true}`.
2. Open a second terminal, and run `pnpm vitehub logs list --json`. Find the event with the message `Status checked`. It has your `message` and `deployment` fields, and the `path` `/api/status`.
3. Open `/api/status` again, and run the command again to see a new event.

The Logs section of the [Console](/docs/development/console) reads the same events with the `logs.list` operation, in Explorer and Stream views.

::

## What happens when you deploy

Local capture works only in development. In production, Logs reads your events from the log service that you already use. See [Read an existing backend](/docs/logs/configure#read-an-existing-backend).

Local capture requires Nitro 3, in Vite or Nuxt 5.

For a larger example, run `playground/logs` in the ViteHub repository. It shows a checkout request, redacted fields, and a diagnostic. Its README tells you how to start it.

## Next steps

::card-group
:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/logs/configure"}
Pass Evlog options and read logs from your own backend.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/logs/hosts"}
See how Logs works on Cloudflare, Vercel, and other hosts.
:::

:::card{title="Server API" icon="i-lucide-code" to="/docs/logs/server-api"}
Use the Evlog logger and write your own log source.
:::
::
