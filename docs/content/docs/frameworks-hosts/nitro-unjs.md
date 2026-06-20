---
title: Nitro and UnJS
description: Understand the narrow boundary between ViteHub, Nitro, and UnJS server runtimes.
navigation.order: 41
icon: i-lucide-server
---

ViteHub is not a Nitro module system.
ViteHub uses Vite Integrations as the public integration layer, while package-owned Nitro wiring appears only where a host boundary needs generated runtime hooks.

## Boundary

| Layer | ViteHub expectation |
| --- | --- |
| Vite | Public integration layer for discovery, generated files, DevTools, and Provider Output. |
| Nitro | Host runtime bridge when a package must register generated handlers, middleware, or runtime hooks. |
| UnJS libraries | Useful implementation dependencies for server primitives, not public ViteHub framework identity. |
| Application server code | Calls Runtime Helpers and stable handlers without importing generated Nitro internals. |

## Accepted Nitro handoffs

| Bridge | Status | Owner | Purpose |
| --- | --- | --- | --- |
| Schedule Provider Wake | Available | Schedule Package | Registers Cloudflare scheduled runtime hooks and cron output for Nitro-shaped hosts. |
| Workspace hosted runtime setup | Available where hosted stores require it | Workspace Package | Moves generated Workspace runtime setup into Nuxt's top-level Nitro config. |
| Database Nuxt D1 host wiring | Available for Nuxt D1 host resources | Database Package | Keeps one D1 Database Host Resource in sync with Nuxt Content and Cloudflare output. |
| General Nitro-first integration | Not the public direction | Not applicable | ViteHub keeps the public contract on Vite Integrations. |

## Current generated route output

::warning
Auth and Agent generated Nitro handlers exist in current package output, but the accepted public direction remains Vite-first. Treat them as generated Provider Output under domain review, not as a general Nitro Framework Integration or public `@vite-hub/*/nitro` authoring surface.
::

| Output | Current owner | Boundary |
| --- | --- | --- |
| Auth route handler | Auth Package | Exposes generated `/api/auth/**` behavior while the Auth/Nitro boundary remains unresolved. |
| Agent chat and webhook routes | Agent Package | Dispatches generated Agent route output without making Nitro discovery or route files the app API. |

## Use stable handlers

Manual hosts should mount stable ViteHub handlers when a package exposes one.
Generated Nitro files stay package-owned Provider Output.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  database: true,
})
```

```ts [vite.config.ts]
import { hubAuth } from '@vite-hub/auth/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubAuth(),
  ],
})
```

## What not to do

Do not treat Nitro route files as the primary ViteHub API.
If a package generates Nitro output, inspect it as Provider Output and keep application code on the package's Runtime Helpers or stable server handler.

## Next steps

- Use [Vite](/docs/frameworks-hosts) for the public integration model.
- Use [Provider output](/docs/reference/provider-output) for generated Nitro and host artifacts.
- Use [Import paths](/docs/reference/import-paths) for public imports.
