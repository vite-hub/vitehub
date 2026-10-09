---
title: KV
navigation.title: Overview
description: Store and retrieve small values by key through one key-value API.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="One key-value import for settings, flags, cursors, and cache records, on every supported host." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [server/api/settings.get.ts]
  import { kv } from '@vite-hub/kv'

  export default defineEventHandler(async () => {
    const [error, settings] = await kv.get('settings')
    if (error) throw error
    return settings
  })
  ```

  ```ts [vite.config.ts]
  import { hubKv } from '@vite-hub/kv/vite'

  export default { plugins: [hubKv()] }
  ```

  ```ts [server/agents/support.ts]
  import { defineAgent } from 'vite-hub/agent'
  import { kv } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    capabilities: [
      kv({ mode: 'write', store: 'tenant-preferences', policy: 'require-approval' }),
    ],
  })
  ```

  ```bash [Terminal]
  pnpm vitehub kv list --prefix users:
  pnpm vitehub kv get settings --json
  pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
  pnpm vitehub kv list --store tenant-preferences
  ```
  :::
::


::product-features
  :::product-feature-item{title="Errors are values" size="large" icon="i-lucide-code-2" to="/docs/kv/server-api"}
  `[error, value]` on every method, with the provider cause attached.
  :::

  :::product-feature-item{title="One import, every host" icon="i-lucide-sliders-horizontal" to="/docs/kv/configure#providers"}
  The host selects fs-lite, Cloudflare KV, Upstash, or Deno KV.
  :::

  :::product-feature-item{title="Named stores keep tenants apart" icon="i-lucide-database-zap" to="/docs/kv/configure#configuration-options"}
  Declare stores in config, select one with `kv.store(name)`.
  :::

  :::product-feature-item{title="The same store, as a tool for an Agent" icon="i-lucide-bot" to="/docs/kv/agent-capability"}
  `kv_read` and `kv_edit` tools, limited to one store, gated by policy.
  :::

  :::product-feature-item{title="Keys from a terminal" icon="i-lucide-terminal" to="/docs/kv/hosts#read-and-write-keys-during-development"}
  Run KV commands against the Vite Development Server.
  :::

  :::product-feature-item{title="Atomic reads and counters" icon="i-lucide-circle-plus" to="/docs/kv/server-api"}
  Use `getAndDelete()` and `increment()` for single-use values and counters.
  :::
::
