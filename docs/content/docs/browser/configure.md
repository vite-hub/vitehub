---
title: Browser configuration
description: Set the Browser Run binding, the session engine, and remote local development.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configuration

`browser: true` turns on Cloudflare Browser Run. Pass an object only to change the binding or engine, or to use the hosted service locally.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'cloudflare',
    browser: {
      binding: 'RENDER_BROWSER',
      remote: true,
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'cloudflare',
      browser: {
        binding: 'RENDER_BROWSER',
        remote: true,
      },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
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
:::
::

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binding` | `string` | `'BROWSER'` | Browser Run binding name. Must be a valid binding identifier. |
| `engine` | `'kitesurf' \| 'chromium'` | `'kitesurf'` | Session engine for `browser.open()`. `'chromium'` uses a persistent Chromium session. |
| `remote` | `boolean` | `false` | Use the hosted Browser Run service in local Wrangler development. |

`browser: false` turns off Browser Provider Output. Without `vite-hub`, pass the same options to `hubBrowser()` from `@vite-hub/browser/vite`.
