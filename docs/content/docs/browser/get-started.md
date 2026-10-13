---

title: Run your first Browser Definition
description: Read a page with Cloudflare Browser Run and return its rendered HTML.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Fetch the rendered HTML of `https://example.com` with a browser running on Cloudflare. You will define one browser operation and expose it through an API route. The route returns the browser's native `Response`.

You need Node.js 24.15 or newer, pnpm, a Vite application, and a Cloudflare account with Browser Run enabled. Run the commands from the app root. This example uses a remote browser even when Wrangler runs locally, so provider usage can incur charges. For a local Chromium process, see [Hosts](/docs/browser/hosts).

::tutorial-step{title="Install and configure"}
## Install and configure

Install the app dependencies and Wrangler, the Cloudflare development tool.

```bash [commands/install]
pnpm add vite-hub nitro h3
pnpm add -D vite wrangler
```

Enable Browser on the Cloudflare deployment preset.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default {
  plugins: [vitehub({
    preset: 'cloudflare',
    browser: { remote: true },
  }), nitro() as never],
}
```

::

::tutorial-step{title="Define a browser operation"}
## Define a browser operation

Place Browser Definitions in `server/browsers/` or name them `*.browser.ts`.

The file name registers the operation as `page-html`. `browser.content()` opens the supplied URL and reads its HTML in the browser session.

```ts [server/browsers/page-html.ts]
import { defineBrowser } from 'vite-hub/browser'

export default defineBrowser(async (
  input: { url: string },
  { browser },
) => {
  return await browser.content(input.url)
})
```

::

::tutorial-step{title="Run it by name"}
## Run it by name

The route passes the request body to the named operation. For this local check, only send the fixed URL below. Add authentication and a URL allowlist before exposing a route that accepts arbitrary URLs.

```ts [server/api/page-html.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { runBrowser } from 'vite-hub/browser'

export default defineEventHandler(async (event) => {
  const input = await readBody<{ url: string }>(event)
  return await runBrowser('page-html', input)
})
```

::

The generated Browser registry infers each Definition's input type. `runBrowser()` returns a native `Response`. Discovery and provider failures return a non-2xx JSON `Response`.

::tutorial-step{title="Verify the response"}
## Verify the response

Build the Cloudflare Worker, then start Wrangler with the generated binding.
Remote mode calls Cloudflare Browser Run and requires account access. Sign in
to the account that has Browser Run enabled:

```bash [commands/request]
pnpm wrangler login
pnpm vite build
pnpm wrangler dev --config .output/server/wrangler.json
```

Keep Wrangler running and send the request from another terminal:

```bash [commands/request-browser]
curl -X POST http://localhost:8787/api/page-html \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

The response is the HTML returned by the Browser provider. Read
[Server API](/docs/browser/server-api) for page sessions, screenshots, and
stateless actions.

::
