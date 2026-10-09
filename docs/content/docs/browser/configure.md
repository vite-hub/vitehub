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
      preset: 'cloudflare',
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
