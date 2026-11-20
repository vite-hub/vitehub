---
title: Capture your first log event
navigation.title: Get started
navigation.order: 2
description: "Install Evlog, turn on local capture in vitehub(), add fields to one request event, and inspect the event in the Console."
layout: tutorial
icon: i-lucide-logs
---

Logs shows what your server did on each request. ViteHub uses [Evlog](https://evlog.dev), a logging library, to write one log event for each request. You add your own data to that event and read it in the CLI or the Console.

In this tutorial, you add data to the log event of one API route. Then you call the route and read its event.

> [!NOTE] Before you start
> Use a Vite app with Nitro 3, such as the app from [Installation](/docs/getting-started/installation). You need no account and no API key. Everything runs on your computer.

::tutorial-step{title="Install Evlog"}

Add Evlog to your app:

```bash pm [commands/install]
pnpm add evlog
```

::

::tutorial-step{title="Enable local capture"}

Add `logs` and `console` to the ViteHub options of your app. Keep your other options. In Vite, `vitehub()` includes Nitro. In a Nitro app, keep `nitro()` after `vitehub()`.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { logs: false, console: false },
  $development: {
    vitehub: { logs: true, console: { auth: false } },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig(({ command }) => {
  return {
    plugins: [
      vitehub({
        logs: command === 'serve' ? true : false,
        console: command === 'serve' ? { auth: false } : false,
      }),
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
  return {
    plugins: [
      vitehub({
        logs: command === 'serve' ? true : false,
        console: command === 'serve' ? { auth: false } : false,
      }),
    ],
  }
})
```
::::
:::

- `logs: true` keeps log events in memory on your computer, only in development. The production configuration disables capture, because each server process would otherwise keep its own short history. See [What happens when you deploy](#what-happens-when-you-deploy).
- `auth: false` lets you open the Console with no sign-in while the dev server runs. These configs disable the Console in production. See [Console](/docs/console) before you deploy.

::

::tutorial-step{title="Add request data"}

Create `server/api/status.get.ts` to add a message and environment name to the request's log event:

```ts [server/api/status.get.ts]
import { useLogger } from 'evlog/nitro/v3'
import { defineHandler } from 'nitro/h3'

export default defineHandler((event) => {
  useLogger(event).set({ message: 'Status checked', deployment: { environment: 'development' } })
  return { ok: true }
})
```

- `useLogger(event)` returns the Evlog event created for this request.
- `.set()` adds your fields to that event.

::

::tutorial-step{title="Inspect the request"}

Start the dev server:

```sh [commands/start]
pnpm dev
```

1. Open `http://localhost:3000/api/status` in your browser to see `{"ok":true}`.
2. In a second terminal, run `pnpm vitehub logs list --json`. Find the event with the message `Status checked`. It has your `message` and `deployment` fields, and the `path` `/api/status`.
3. Refresh `/api/status` and run the command again to see the new event.

The Logs section of the [Console](/docs/console) reads the same events with the `logs.list` operation, in its Explorer and Stream views.

::

## What happens when you deploy

Local capture works only in development and requires Nitro 3 in Vite or Nuxt 5. In production, Logs reads your events from the log service that you already use. See [Read an existing backend](/docs/logs/configure#read-an-existing-backend).

For a richer example with a checkout request, redacted fields, and a diagnostic, run `playground/logs` in the ViteHub repository and follow its README.

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
