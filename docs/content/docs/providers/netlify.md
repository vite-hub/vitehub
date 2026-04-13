---
title: Netlify
description: Deploy ViteHub packages on Netlify Functions.
icon: i-logos-netlify-icon
---

# Netlify

Netlify provides serverless functions with built-in Blobs, edge functions, and scheduled functions.

## Configuration

::fw{nitro nuxt}
```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@vitehub/dummy/nuxt'],
  dummy: {
    provider: 'netlify',
    adapter: 'server',
  },
})
```
::

::fw{vite}
```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { hubDummy } from '@vitehub/dummy/vite'

export default defineConfig({
  plugins: [hubDummy({ provider: 'netlify', adapter: 'server' })],
})
```
::

## Adapters

Netlify supports `server` and `edge` adapters. The `server` adapter runs on Netlify Functions (Node.js), while `edge` runs on Netlify Edge Functions (Deno).
