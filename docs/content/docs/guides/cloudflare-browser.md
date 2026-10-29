---
title: Run browser operations on Cloudflare with ViteHub
description: Select Cloudflare Browser Run, define a browser operation, and verify rendered HTML through a ViteHub server route.
navigation.title: Cloudflare Browser Run
navigation.order: 21
navigation.group: Server work
icon: i-lucide-globe
---

Use Cloudflare Browser Run when a Worker needs a remote browser. ViteHub
discovers Browser Definitions and calls them through `runBrowser()`.

Follow [Run your first Browser Definition](/docs/browser/get-started) to create
the `page-html` operation and its POST route. You need a Cloudflare account
with Browser Run access. Remote mode uses the service even during local
Wrangler development and can incur charges.

## Select remote browser access

Use this configuration in the tutorial's app:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
	plugins: [vitehub({
		preset: 'cloudflare',
		browser: { remote: true },
	})],
})
```

Keep Browser operations in `server/browsers/`. A Definition receives the
provider-backed browser, while application code calls its discovered name.

## Check the generated binding

Install Wrangler if it is absent. Authenticate to the account with Browser Run
access, then build and run the Worker configuration:

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

The response is the rendered page HTML. Check the HTTP status before reading
the body. A provider or discovery error returns a non-2xx response.

## Limit remote access

The tutorial accepts a URL for a local check. Before publishing that route,
add authentication and restrict the URLs it can open. Browser network access
is separate from the caller's right to invoke your API.

This guide uses the built-in Cloudflare provider. It does not configure
Browserbase. Local Chromium has a separate programmatic path in
[Browser hosts](/docs/browser/hosts).

Read [Browser limits](/docs/browser/limits-and-errors) and
[Cloudflare Browser Run documentation](https://developers.cloudflare.com/browser-rendering/)
for timeouts, concurrency, and account limits.
