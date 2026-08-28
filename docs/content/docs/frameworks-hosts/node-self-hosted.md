---
title: Node and self-hosted
description: Use ViteHub Runtime Helpers in Node-shaped hosts without pretending every primitive has unified self-hosted output.
navigation.order: 47
navigation.group: Deployment hosts
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
| Unified self-hosted Provider Output | Not provided | ViteHub does not emit one general Node deployment bundle for all primitives. |

## Runtime Helper boundary

Server code calls the same Runtime Helpers used in hosted applications. The provider or store choice remains in package configuration.

```ts [server/settings.ts]
import { kv } from '@vite-hub/kv'

export async function saveSettings(settings: Record<string, unknown>) {
  const [error] = await kv.set('settings', settings)
  if (error) throw error
}
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
    base: '.vitehub/data/kv',
  },
})
```

## Auth handler boundary

The Auth Package exposes a stable server handler that a Node framework can mount through its request API. The handler comes from the application Definition; generated host files remain implementation details unless the package reference marks them public.

```ts [server/manual-auth-handler.ts]
import { defineAuth } from '@vite-hub/auth'
import { createAuthHandler } from '@vite-hub/auth/server'

const definition = defineAuth({
  appName: 'Acme',
  route: false,
})

export const handleAuth = createAuthHandler(definition)
```

`handleAuth` accepts a Web `Request` and returns a `Promise<Response>`. Adapt that handler at the Node framework boundary instead of importing a generated Nitro route.

## Production notes

Self-hosted deployments must make durability explicit.
Memory providers and single-process local state are development providers, not production coordination systems.

Use Server Env for runtime secrets, configure durable stores for stateful primitives, and add verification that starts the deployed Node process rather than only typechecking package code.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the qualified self-hosted boundary.
- Use [Import paths](/docs/reference/import-paths) for stable runtime imports.
- Use [Config options](/docs/reference/config-options) for local and hosted providers.
- Use [Verification](/docs/development/verification) to choose a self-hosted proof path.
