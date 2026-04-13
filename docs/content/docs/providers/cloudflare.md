---
title: Cloudflare
description: Deploy ViteHub packages on Cloudflare Workers and Pages.
icon: i-logos-cloudflare-icon
---

# Cloudflare

Cloudflare Workers and Pages provide edge computing with built-in KV, D1, R2, Queues, and more.

## Configuration

::fw{nitro nuxt}
```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@vitehub/dummy/nuxt'],
  dummy: {
    provider: 'cloudflare',
    binding: 'DUMMY',
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
  plugins: [hubDummy({ provider: 'cloudflare', binding: 'DUMMY' })],
})
```
::

## Bindings

Cloudflare uses [bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) to connect your worker to platform resources. Each ViteHub package maps to a specific binding type.
