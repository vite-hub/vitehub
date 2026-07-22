---
title: Nitro and UnJS
description: Understand the narrow boundary between ViteHub, Nitro, and UnJS server runtimes.
navigation.order: 42
icon: i-lucide-server
---

ViteHub is not a Nitro module system.
ViteHub uses Vite Integrations as the public integration layer, while package-owned Nitro wiring appears only where a host boundary needs generated runtime hooks.

## Boundary

| Layer | ViteHub expectation |
| --- | --- |
| Vite | Public integration layer for discovery, generated files, the CLI Agent Dev Loop, and Provider Output. |
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

## Generated route output

::warning
Auth and Agent integrations generate Nitro handlers for their owned routes. Treat those files as Provider Output, not as a general Nitro Framework Integration or a public `@vite-hub/*/nitro` authoring surface.
::

| Output | Current owner | Boundary |
| --- | --- | --- |
| Auth route handler | Auth Package | Exposes the configured Auth route through a generated Nitro handler. |
| Agent chat and webhook routes | Agent Package | Dispatches generated Agent route output without making Nitro discovery or route files the app API. |

## Package-owned handlers

The package Vite Integration reads the application Auth Definition and generates Nitro route output when `route` is enabled.

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

- Use [Frameworks and hosts](/docs/frameworks-hosts) for the public integration model.
- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the complete qualified matrix.
- Use [Provider output](/docs/reference/provider-output) for generated Nitro and host artifacts.
- Use [Import paths](/docs/reference/import-paths) for public imports.
