---
title: Logs
layout: landing
navigation.title: Overview
navigation.order: 1
description: "Structured request logs for Vite apps with Evlog. Capture events locally, read an existing backend, and inspect them in the Console and the CLI."
icon: i-lucide-logs
---

::product-hero{tagline="Structured logs powered by Evlog, with Explorer, Stream, and a data inspector." hosts="Local development, existing backends"}
  :hero-figure{name="logs"}
::

::code-tree
:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', observability: { logs: true } },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'node', observability: { logs: true } }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', observability: { logs: true } })],
})
```
:::
::

ViteHub Logs uses Evlog for structured request events. Keep Evlog's logger API, framework adapters, options, and drains. ViteHub adds a read contract, Console inspection, and CLI access.

::product-features
  :::product-feature-item{title="Start locally" icon="i-lucide-terminal" to="/docs/logs/get-started"}
  Add fields to one request event and see it in the Console.
  :::
  :::product-feature-item{title="Keep your pipeline" icon="i-lucide-plug" to="/docs/logs/configure#read-an-existing-backend"}
  Read from your existing backend without a second exporter.
  :::
  :::product-feature-item{title="Inspect structured data" icon="i-lucide-logs" to="/docs/logs/server-api"}
  Search events in Explorer or Stream and open their fields in the inspector.
  :::
  :::product-feature-item{title="Know the limits" icon="i-lucide-circle-alert" to="/docs/logs/limits-and-errors"}
  Local retention is temporary. Follow polls the source and can miss events.
  :::
::
