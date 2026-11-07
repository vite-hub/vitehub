---
title: Auth hosts
description: What Better Auth owns, what ViteHub Auth owns, and which files Auth generates for each host.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

Better Auth is the only Auth provider. ViteHub keeps its storage, OAuth providers, and client plugins.

| Concern | Owner |
| --- | --- |
| Sign-in methods, OAuth providers, plugins | Better Auth options in the Auth Definition. |
| User and session storage | `authDatabase()`, which adds the Better Auth tables to the app Database, or a Better Auth database adapter that the callback or `runtime` returns. |
| Route mounting | A generated Nitro handler, also in development when Nitro runs in the Vite dev server. In plain Vite development, `hubAuth()` serves the route. Manual hosts mount `#vitehub/auth/server`. |
| Roles and permissions | Your `authorize` callbacks. ViteHub defines no roles. |

## Provider output

Provider output is the code Auth generates for the host: the Definition module, route handler, access middleware, and ambient types (`.vitehub/types/auth.d.ts`). Your code imports `@vite-hub/auth/server` or Better Auth clients, never these files.

Set `route: false` only when a host integration or your own route mounts the Auth handler.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```
