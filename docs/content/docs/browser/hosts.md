---
title: Browser hosts
description: Browser providers, host support, and Cloudflare Provider Output.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

| Path | Provider | Host support |
| --- | --- | --- |
| Browser Definitions and actions | Cloudflare Browser Run | Cloudflare preset only. Other presets throw a configuration error. |
| `createBrowser()` with `cloudflareBrowser()` | Cloudflare Browser Run | Cloudflare Workers with a Browser binding. |
| `createBrowser()` with `localBrowser()` | Local Chromium process | Trusted Node hosts. `browser: true` never selects it. |

The Cloudflare preset writes the Browser Run binding, a default `compatibility_date`, and the `nodejs_compat` flag to the generated `wrangler.json`. Both the root integration and `hubBrowser()` preserve unrelated Wrangler fields.

Cloudflare's Worker `quickAction()` requires remote mode during local development. Set `remote: true` when local Wrangler development must call Browser Run. This uses a Cloudflare account and network access.

Install `@cloudflare/playwright` and `playwright-core` when you set `engine: 'chromium'`. Stateless actions and the default Kitesurf engine do not need these optional peers.
