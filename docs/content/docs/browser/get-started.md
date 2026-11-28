---

title: Run your first Browser Definition
description: Define a browser operation, run it by name with Cloudflare Browser Run, and verify the rendered HTML it returns.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Browser gives your server a real web browser. The browser runs on Cloudflare, not on your server. You can open a page, read it after its scripts run, or take a screenshot.

In this tutorial, you define a browser task that fetches the HTML of `https://example.com` and call it from an API route.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation) and run commands from the app root. You need a Cloudflare account with Browser Run turned on. Because the browser runs on Cloudflare even during local testing, each run can cost money. To use a local Chromium browser instead, see [Hosts](/docs/browser/hosts).

::tutorial-step{title="Install and configure"}
## Install and configure

Install the Browser package, Valibot, and Cloudflare's Wrangler CLI. With pnpm 11 or later, first [set the Wrangler builds in `allowBuilds`](/docs/frameworks-hosts/cloudflare#install-wrangler).

```bash pm [commands/install]
pnpm add @vite-hub/browser valibot
pnpm add -D wrangler
```

In your ViteHub options, set `host: 'cloudflare'` and turn on Browser alongside your other options.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    browser: { remote: true },
  },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    browser: { remote: true },
  }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    browser: { remote: true },
  })],
})
```
::::
:::

- `host: 'cloudflare'` builds your app for Cloudflare, which Browser requires.
- `remote: true` connects local test runs to the browser on Cloudflare.

::

::tutorial-step{title="Define a browser operation"}
## Define a browser operation

Create `server/browsers/page-html.ts`. The file name is the name of the task: `page-html`. ViteHub finds browser tasks in `server/browsers/` and in files that end in `.browser.ts`.

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```

- `input` holds what the caller sends, here a URL.
- `browser.content(input.url)` opens the page and returns its HTML.

::

::tutorial-step{title="Run it by name"}
## Run it by name

Create `server/api/page-html.post.ts`. This route checks the request body and sends it to the `page-html` task:

```ts [server/api/page-html.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { runBrowser } from 'vite-hub/browser'
import { toResponse } from 'vite-hub/runtime'

export default defineEventHandler(async (event) => {
  const input = await readValidatedBody(event, body => v.parse(v.object({ url: v.pipe(v.string(), v.minLength(1)) }), body))
  const [error, html] = await runBrowser('page-html', input)
  if (error) return toResponse(error)
  return html
})
```

- The route responds with `400` if the body has no non-empty `url` string.
- `runBrowser('page-html', input)` runs the task by its name. ViteHub knows the input type of each task, so TypeScript checks `input`.
- It returns `[error, html]`. `html` is the value that the task returned. If the task fails, `toResponse(error)` answers with an error status and `{ code, why, fix }`.

This route opens any URL that it gets. In this tutorial, send only the URL below. Before you deploy, add sign-in and a list of allowed URLs.

::

::tutorial-step{title="Verify the response"}
## Verify the response

Sign in to the Cloudflare account that has Browser Run. Then build the app and start it with Wrangler:

```bash [commands/request]
pnpm wrangler login
pnpm vite build
pnpm wrangler dev --config .output/server/wrangler.json
```

In a second terminal, send a URL to the route:

```bash [commands/request-browser]
curl -X POST http://localhost:8787/api/page-html \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

The response is the HTML of `https://example.com`.

::

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code" to="/docs/browser/server-api"}
Keep a page open, take screenshots, and run browser actions.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/browser/configure"}
Configure the binding, session engine, and remote mode.
:::

:::card{title="Limits and errors" icon="i-lucide-triangle-alert" to="/docs/browser/limits-and-errors"}
Review Browser Run limits and production checks.
:::
::
