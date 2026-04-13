---
title: Vercel
description: Deploy ViteHub packages on Vercel Serverless and Edge Functions.
icon: i-simple-icons-vercel
---

# Vercel

Vercel provides serverless and edge functions with integrations for KV, Blob, Postgres, and more.

## Configuration

::fw{nitro nuxt}
```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@vitehub/dummy/nuxt'],
  dummy: {
    provider: 'vercel',
    runtime: 'edge',
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
  plugins: [hubDummy({ provider: 'vercel', runtime: 'edge' })],
})
```
::

## Runtimes

Vercel supports both `nodejs` and `edge` runtimes. The `edge` runtime provides lower latency but has a smaller API surface.
