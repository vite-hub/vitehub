---
title: Node and self-hosted
description: Use ViteHub Runtime Helpers in Node-shaped hosts without pretending every primitive has unified self-hosted output.
navigation.order: 44
icon: i-lucide-server-cog
---

Node and self-hosted runtimes can use ViteHub server primitives when the package exposes host-neutral Runtime Helpers or stable server handlers.
Unified self-hosted Provider Output is not the default contract for every package.

## What works today

| Surface | Status | Boundary |
| --- | --- | --- |
| Runtime Helpers in server code | Available per package | Use the package root or runtime subpath imports. |
| Local filesystem and memory providers | Available where a primitive supports them | Useful for development and simple self-hosted setups. |
| Stable server handlers | Available per package | Mount the handler the package marks stable, such as Auth server behavior. |
| Unified self-hosted Provider Output | Planned | ViteHub does not yet emit one general Node deployment bundle for all primitives. |

## Use Runtime Helpers

Server code should call Runtime Helpers the same way it does in hosted apps.
The provider or store choice belongs in package configuration.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubKv(),
  ],
  kv: {
    driver: 'fs-lite',
    base: '.data/kv',
  },
})
```

## Mount stable handlers manually

When a package exposes a stable server handler, mount that handler in the host instead of copying generated provider code.
Generated host files remain implementation details unless the package reference marks them public.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```

## Production notes

Self-hosted deployments must make durability explicit.
Memory providers and single-process local state are development providers, not production coordination systems.

Use Server Env for runtime secrets, configure durable stores for stateful primitives, and add verification that starts the deployed Node process rather than only typechecking package code.

## Next steps

- Use [Import paths](/docs/reference/import-paths) for stable runtime imports.
- Use [Config options](/docs/reference/config-options) for local and hosted providers.
- Use [Verification](/docs/development/verification) to choose a self-hosted proof path.
