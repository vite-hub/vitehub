---

title: Run your first Browser Definition
description: Define a browser operation, run it by name with Cloudflare Browser Run, and verify the rendered HTML it returns.
layout: tutorial
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You write a small job that opens a web page in a real browser on Cloudflare and returns the page's HTML. At the end, you call it from an API route and see the HTML of `https://example.com`.

You need:

- Node.js 22.22 or newer
- pnpm
- a Vite app. Run all commands from its root folder.
- a Cloudflare account with Browser Run turned on

The browser runs on Cloudflare, also when you test on your computer. Cloudflare can charge you for this use.

You do not need to install Chrome or Chromium on your computer.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the packages:

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite wrangler
```

- `vite-hub` gives you Browser.
- `nitro` and `h3` serve the API route.
- `wrangler` is the Cloudflare tool that runs your app like a Cloudflare Worker on your computer.

Turn on Browser in `vite.config.ts`:

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

export default {
  plugins: [vitehub({
    preset: 'cloudflare',
    browser: { remote: true },
  })],
}
```

- `preset: 'cloudflare'` builds the app for Cloudflare Workers. Browser works only with this preset.
- `remote: true` connects local development to the browser on Cloudflare.

::

::tutorial-step{title="Write the browser job"}
## Write the browser job

A browser job is a file in `server/browsers/`, or a file with a name that ends in `.browser.ts`. The file name is the job name. This file makes a job with the name `page-html`.

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```

- `input` is the data that the caller sends. Here it is one URL.
- `browser.content()` opens the URL and returns the HTML of the page.

::

::tutorial-step{title="Run it by name"}
## Run it by name

Create an API route that runs the job:

```ts [server/api/page-html.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-html', input)
})
```

`runBrowser()` runs the `page-html` job with the request body as `input`. TypeScript knows the input type of each job, so a wrong input shows an error in your editor. `runBrowser()` returns a standard `Response`. When it cannot find the job or reach Cloudflare, the `Response` has an error status and a JSON body.

> [!NOTE]
> This route opens any URL that a caller sends. Before you put it online, add sign-in and a list of allowed URLs.

::

::tutorial-step{title="Check the response"}
## Check the response

Sign in to the Cloudflare account that has Browser Run. Then build the app and start it with Wrangler:

```bash [commands/request]
pnpm wrangler login
pnpm vite build
pnpm wrangler dev --config .output/server/wrangler.json
```

`vite build` writes the Worker and its `wrangler.json` config to `.output/server/`. `wrangler dev` runs that Worker on port 8787.

Keep Wrangler running. In another terminal, send a request:

```bash [commands/request-browser]
curl -X POST http://localhost:8787/api/page-html \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

You see the HTML of `https://example.com`. This proves that the browser on Cloudflare opened the page and that your route returned its HTML.

::

## Next steps

- [Server API](/docs/browser/server-api): take screenshots and keep a page open between steps.
- [Hosts](/docs/browser/hosts): run a local Chromium process on your own Node.js server.
- [Configure](/docs/browser/configure): change the Browser Run binding and the browser engine.
