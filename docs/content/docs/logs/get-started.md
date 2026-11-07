---
title: Read your first request log
navigation.title: Get started
navigation.order: 2
description: Add data to the log of one API request, then read it in the ViteHub Console.
layout: tutorial
icon: i-lucide-logs
---

You add your own data to the log of one API request. Then you open the log in the ViteHub Console, a page in your app where you read logs.

You need:

- a Vite app with Nitro 3, such as the app from [Installation](/docs/getting-started/installation)
- pnpm

You do not need a log service or a cloud account. The logs stay on your computer while `vite dev` runs.

::tutorial-step{title="Install Evlog"}
## Install Evlog

Install [Evlog](https://evlog.dev). It writes one log event for each request, with fields that you can add to:

```sh [commands/install]
pnpm add evlog
```

::

::tutorial-step{title="Turn on Logs"}
## Turn on Logs

Add Logs and the Console to `vite.config.ts`:

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'node', logs: true, console: { auth: false, local: true } }),
    nitro(),
  ],
})
```

- `logs: true` keeps the log events of `vite dev` in memory, so that the Console can show them.
- `console` turns on the Console. `auth: false` and `local: true` let you open it without a sign-in. It answers only requests from your own computer.

::

::tutorial-step{title="Add data to a request"}
## Add data to a request

Create `server/api/status.get.ts`:

```ts [server/api/status.get.ts]
import { useLogger } from 'evlog/nitro/v3'
import { defineHandler } from 'nitro/h3'

export default defineHandler((event) => {
  useLogger(event).set({ message: 'Status checked', deployment: { environment: 'development' } })
  return { ok: true }
})
```

`useLogger(event)` gives you the log event of this request. `set()` adds your fields to it. Evlog writes the event when the request ends.

::

::tutorial-step{title="Read the log"}
## Read the log

Start the app:

```sh [commands/start]
pnpm vite dev
```

Open `/api/status` in the browser. Then open `/_vitehub/logs`. You see a row for the request. Select the row to see its data, with your `message` and `deployment` fields. This proves that your route added data to the request log.

The Console has two views, **Explorer** and **Stream**. Try both. Turn on **Follow** to check for new events every two seconds.

> [!NOTE]
> The local logs keep the last 256 events, and a restart deletes them. Local logs work only in development. For production, connect the store where your logs already go. See [Read an existing backend](/docs/logs/configure#read-an-existing-backend).

::

`logs: true` works with Nitro 3 only. For Nuxt with Nitro 2, add Evlog with its `evlog/nuxt` module. Then connect an [existing backend](/docs/logs/configure#read-an-existing-backend) with `logs: { source: './server/logs.ts' }` in the `vite-hub/nuxt` module options. In this mode, your app sets up the logger itself.

## Next steps

- [Configure](/docs/logs/configure#read-an-existing-backend): read logs from the service that your app already sends them to.
- [Server API](/docs/logs/server-api): learn the log format, and read logs from the CLI.
- `playground/logs` in the ViteHub repository: run a bigger example, with a checkout request, hidden secret values, and an error report. Its README tells you how.
