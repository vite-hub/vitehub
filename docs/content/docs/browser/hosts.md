---
title: Browser hosts
description: "Browser Definitions pick a driver per host: Browser Run on Cloudflare, local Chromium on Node and in dev, and a remote Chromium on Vercel."
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Drivers

`browser: true` picks the driver from the host. Browser Definitions and `runBrowserContent()` work the same with each driver.

| Host | Driver | What to set |
| --- | --- | --- |
| Cloudflare | Browser Run | Nothing. ViteHub writes the Browser binding to `wrangler.json`. |
| Node and Docker | Local Chromium | Install Chromium on the server. ViteHub finds it, or reads `BROWSER_EXECUTABLE_PATH`. |
| Vercel | Remote Chromium over CDP | `BROWSER_CDP_URL`, such as a Browserless or Browserbase WebSocket URL. |
| Dev (`vite dev`, `nuxt dev`) | Local Chromium | The same as Node. Set `remote: true` to call Browser Run from Cloudflare dev. |
| Netlify and Deno | None | `browser: true` fails the build. |

On every Node host, `BROWSER_CDP_URL` wins over the local Chromium. Use it to share one Chromium between servers.

Local Chromium checks these paths in order:

1. `BROWSER_EXECUTABLE_PATH`.
2. The newest Chromium that `npx playwright install chromium` downloaded.
3. A system Chromium or Google Chrome, such as `/usr/bin/chromium`.

When it finds none, the call fails with `BROWSER_R0013` and the fix. For a Docker image, install Chromium in the image:

```dockerfile [Dockerfile]
RUN apt-get update && apt-get install -y chromium
```

Chromium runs in its own sandbox. A root process, the default in Docker, runs without it, because Chromium refuses it. Ubuntu 23.10 and newer can block the sandbox for a downloaded Chromium, and the call fails with `BROWSER_R0016`. On a trusted host, set `BROWSER_SANDBOX=false`.

`BROWSER_CDP_URL` takes two forms. A `ws://` or `wss://` URL is the browser WebSocket, with its token if the service needs one. An `http://` or `https://` URL is a Chromium that runs with `--remote-debugging-port`. ViteHub opens one page per session there and closes it at the end. The URL can hold a token, so keep it in a secret.

Off Cloudflare, `runBrowserContent()` opens the URL in a page and returns its HTML. The other Browser Run quick actions, such as `runBrowserAction("screenshot")`, fail with `BROWSER_R0015`. Open a session with `browser.open()` for that work.

## Cloudflare

The Cloudflare host writes the Browser Run binding, a default `compatibility_date`, and the `nodejs_compat` flag to the generated `wrangler.json`. `vitehub()` and `hubBrowser()` keep your other Wrangler fields.

In `vite dev` with the Cloudflare host, Browser Definitions use local Chromium. Set `remote: true` so local Wrangler calls Browser Run instead. This needs a Cloudflare account and network access.

With `engine: 'chromium'`, install `@cloudflare/playwright` and `playwright-core`. Stateless actions and the default Kitesurf engine do not need them.

## Low-level clients

`createBrowser()` takes a driver that you choose: `cloudflareBrowser()`, `localBrowser()`, or `cdpBrowser({ url })` from `vite-hub/browser/providers/cdp`. Use it when your code owns the session and its cleanup.

## Builds without Browser

An app that deploys to several hosts can import Browser on all of them. A build without Browser still builds, but calls fail with `BROWSER_UNAVAILABLE`. The message names the host, the reason, and the fix. Call `isBrowserAvailable()` first to branch:

```ts [server/api/example-html.get.ts]
import { defineEventHandler } from 'h3'
import { isBrowserAvailable, runBrowserContent } from 'vite-hub/browser'

export default defineEventHandler(async () => {
  if (!isBrowserAvailable()) return { html: null }
  const [error, html] = await runBrowserContent('https://example.com')
  if (error) throw error
  return { html }
})
```

`isBrowserAvailable()` reads the build, not the provider. It returns `true` in a build with `browser: true`, even when the binding is missing at runtime.

## Related guides

Read [Cloudflare Browser Run](/docs/guides/cloudflare-browser) for binding setup and a rendered HTML check.
