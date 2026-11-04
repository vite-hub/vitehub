---
title: Browser hosts
description: "Choose a Browser provider for each host: Cloudflare Browser Run on Workers, or a local Chromium process on trusted Node hosts."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Path | Provider | Host support |
| --- | --- | --- |
| Browser Definitions and actions | Cloudflare Browser Run | Cloudflare preset only. `browser: true` with another preset fails the build. |
| `createBrowser()` with `cloudflareBrowser()` | Cloudflare Browser Run | Cloudflare Workers with a Browser binding. |
| `createBrowser()` with `localBrowser()` | Local Chromium process | Trusted Node hosts. `browser: true` never selects it. |

The Cloudflare preset writes the Browser Run binding, a default `compatibility_date`, and the `nodejs_compat` flag to the generated `wrangler.json`. Both the root integration and `hubBrowser()` preserve unrelated Wrangler fields.

Cloudflare's Worker `quickAction()` requires remote mode during local development. Set `remote: true` when local Wrangler development must call Browser Run. This uses a Cloudflare account and network access.

Install `@cloudflare/playwright` and `playwright-core` when you set `engine: 'chromium'`. Stateless actions and the default Kitesurf engine do not need these optional peers.

## Builds without Browser

An application that deploys to more than one host can import Browser on every host. A build that does not enable Browser still builds. Calls fail with `BROWSER_UNAVAILABLE`, and the message names the preset, the reason, and the fix. Call `isBrowserAvailable()` to branch before you call Browser:

```ts [server/api/example-html.get.ts]
import { defineEventHandler } from 'h3'
import { isBrowserAvailable, runBrowserContent } from 'vite-hub/browser/actions'

export default defineEventHandler(async () => {
  if (!isBrowserAvailable()) return { html: null }
  return { html: await runBrowserContent('https://example.com') }
})
```

`isBrowserAvailable()` reads the build, not the provider. It returns `true` in a build with `browser: true`, also when the Browser Run binding is missing at runtime.

## Related guides

Use [Cloudflare Browser Run](/docs/guides/cloudflare-browser) for binding
setup and a rendered HTML check.
