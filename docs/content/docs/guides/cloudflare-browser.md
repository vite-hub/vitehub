---
title: Run browser operations on Cloudflare with ViteHub
description: Select Cloudflare Browser Run, define a browser operation, and verify rendered HTML through a ViteHub server route.
navigation.title: Cloudflare Browser Run
navigation.order: 21
navigation.group: Server work
icon: i-lucide-globe
---

Use Cloudflare Browser Run when a Worker needs a remote browser. You call each
Browser Definition (one browser operation in a file) with `runBrowser()`.

First, create the `page-html` operation and its POST route in
[Run your first Browser Definition](/docs/browser/get-started). You need a
Cloudflare account with Browser Run access. Remote mode uses the paid service
even in local Wrangler dev.

## Select remote browser access

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
  	host: 'cloudflare',
  	browser: { remote: true },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		host: 'cloudflare',
		browser: { remote: true },
	}), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
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
:::
::

Keep Browser operations in `server/browsers/`. A Definition gets the
provider's browser, and your code calls it by name.

## Check the generated binding

Install Wrangler, log in to the account with Browser Run, then build and run
the Worker:

```bash [Terminal]
pnpm add -D wrangler
pnpm wrangler login
pnpm build
pnpm wrangler dev --config .output/server/wrangler.json
```

In another terminal, call the tutorial route:

```bash [Terminal]
curl --fail-with-body http://localhost:8787/api/page-html \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}'
```

The response is the rendered page HTML. Check the status before you read the
body: a provider or discovery error returns a non-2xx status.

## Limit remote access

::warning
The tutorial route opens any URL. Before you publish it, add authentication
and limit the URLs it can open.
::

This guide uses the built-in Cloudflare provider, not Browserbase. For local
Chromium, see [Browser hosts](/docs/browser/hosts). For timeouts, concurrency,
and account limits, read
[Browser limits](/docs/browser/limits-and-errors) and the
[Cloudflare Browser Run docs](https://developers.cloudflare.com/browser-rendering/).
