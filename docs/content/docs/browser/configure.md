---
title: Browser configuration
description: Configure the Browser Run binding, the session engine, and remote local development.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configuration

`browser: true` enables Cloudflare Browser Run actions. Use an object only to change the binding, the session engine, or to connect local development to the hosted service.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      browser: {
        binding: 'RENDER_BROWSER',
        remote: true,
      },
    }),
  ],
})
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | `string` | `'BROWSER'` | Cloudflare Browser Run binding name. Must be a valid binding identifier. |
| `engine` | `'kitesurf' \| 'chromium'` | `'kitesurf'` | Session engine for `browser.open()`. `'chromium'` selects a persistent Chromium session. |
| `remote` | `boolean` | `false` | Connect local Wrangler development to the hosted Browser Run service. |

`browser: false` disables Browser Provider Output. Without `vite-hub`, pass the same options to `hubBrowser()` from `@vite-hub/browser/vite`.

## Choose a session engine

`engine` decides how `browser.open()` gets a session from Browser Run. Stateless actions such as `runBrowserContent()` work with both engines.

| | `'kitesurf'` | `'chromium'` |
| --- | --- | --- |
| Session | Opens through the binding for each request. | Acquires a persistent Chromium session through `@cloudflare/playwright`. |
| `idleTimeoutMs` | Rejected. | Sent to Browser Run as `keep_alive`. |
| [Live handoff](/docs/browser/server-api#live-handoff) | Not supported. | Supported. |
| Extra packages | None. | `@cloudflare/playwright` and `playwright-core`. |

Keep the default `'kitesurf'` unless an Agent or a route must keep one page open across requests or hand a session to another process.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'

vitehub({
  host: 'cloudflare',
  browser: { engine: 'chromium' },
})
```

## What the build writes

With Browser on, the Cloudflare build adds a `browser` binding to the generated Wrangler configuration, turns on `nodeCompat`, and keeps `cloudflare:workers` external. A `browser` binding that you set in `nitro.cloudflare.wrangler` is replaced by the one from these options.

ViteHub finds Browser Definitions in `server/browsers/` and in files that end in `.browser.ts`. It writes their names to `.vitehub/types/browser.d.ts`, so `runBrowser()` checks the name and the input type of each Definition.

## Develop against hosted Browser Run

`remote: true` writes `remote: true` on the Wrangler `browser` binding. Local Wrangler development then uses Browser Run in your Cloudflare account, so local requests open hosted sessions and count toward your Browser Run usage. Sign in with `wrangler login` first.

## Turn Browser off

`browser: false` removes the binding from the generated configuration. Code that imports Browser still builds. Calls fail with `BROWSER_UNAVAILABLE`, and `isBrowserAvailable()` returns `false`. See [Builds without Browser](/docs/browser/hosts#builds-without-browser).

## Configuration errors

The plugin checks the options when Vite resolves its config, before the build starts.

| Code | Cause | Fix |
| --- | --- | --- |
| `BROWSER_B0001` | `binding` is not a valid Cloudflare binding name. | Use letters, digits, and `_`, and do not start with a digit. |
| `BROWSER_B0002` | `engine` is not `'kitesurf'` or `'chromium'`. | Remove `engine`, or set one of the two values. |
