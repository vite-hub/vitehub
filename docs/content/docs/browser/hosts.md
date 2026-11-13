---
title: Browser hosts
description: "Choose a Browser provider per host: Cloudflare Browser Run on Workers, or local Chromium on trusted Node hosts."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Path | Provider | Host support |
| --- | --- | --- |
| Browser Definitions and actions | Cloudflare Browser Run | Cloudflare host only. `browser: true` with another host fails the build. |
| `createBrowser()` with `cloudflareBrowser()` | Cloudflare Browser Run | Cloudflare Workers with a Browser binding. |
| `createBrowser()` with `localBrowser()` | Local Chromium | Trusted Node hosts. `browser: true` never picks it. |

The Cloudflare host writes the Browser Run binding, a default `compatibility_date`, and the `nodejs_compat` flag to the generated `wrangler.json`. `vitehub()` and `hubBrowser()` keep your other Wrangler fields.

The Cloudflare Worker `quickAction()` needs remote mode in local development. Set `remote: true` so local Wrangler can call Browser Run. This needs a Cloudflare account and network access.

With `engine: 'chromium'`, install `@cloudflare/playwright` and `playwright-core`. Stateless actions and the default Kitesurf engine do not need them.

## Builds without Browser

An app that deploys to several hosts can import Browser on all of them. A build without Browser still builds, but calls fail with `BROWSER_UNAVAILABLE`. The message names the host, the reason, and the fix. Call `isBrowserAvailable()` first to branch:

```ts [server/api/example-html.get.ts]
import { defineEventHandler } from 'h3'
import { isBrowserAvailable, runBrowserContent } from 'vite-hub/browser'

export default defineEventHandler(async () => {
  if (!isBrowserAvailable()) return { html: null }
  return { html: await runBrowserContent('https://example.com') }
})
```

`isBrowserAvailable()` reads the build, not the provider. It returns `true` in a build with `browser: true`, even when the binding is missing at runtime.

## Related guides

Read [Cloudflare Browser Run](/docs/guides/cloudflare-browser) for binding setup and a rendered HTML check.
