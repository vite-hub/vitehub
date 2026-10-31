---
title: Logs
navigation.title: Overview
navigation.order: 1
description: Logs for ViteHub Logs, powered by Evlog.
icon: i-lucide-logs
---

::product-hero{tagline="Structured logs powered by Evlog, with Explorer, Stream, and a data inspector." hosts="Local development, existing backends"}
  :::code-group
  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [vitehub({ preset: 'node', logs: true }), nitro()],
  })
  ```
  :::
::

ViteHub Logs uses Evlog for structured request events. Keep Evlog's logger API, framework adapters, options, and drains. ViteHub adds a read contract, Console inspection, and CLI access.

::product-features
  :::product-feature-item{title="Start locally" icon="i-lucide-terminal" to="/docs/logs/get-started"}
  Enrich one request event and inspect it in the Console.
  :::
  :::product-feature-item{title="Keep your pipeline" icon="i-lucide-plug" to="/docs/logs/configure#read-an-existing-backend"}
  Connect a read adapter to an existing backend without starting another exporter.
  :::
  :::product-feature-item{title="Inspect structured data" icon="i-lucide-logs" to="/docs/logs/server-api"}
  Search events in Explorer or Stream and open their fields in the right inspector.
  :::
  :::product-feature-item{title="Know the limits" icon="i-lucide-circle-alert" to="/docs/logs/limits-and-errors"}
  Local retention is temporary. Follow polls the source and can miss events.
  :::
::
