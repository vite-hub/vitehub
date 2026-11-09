---
title: Auth hosts
description: See what Better Auth owns, what ViteHub Auth owns, and which Provider Output Auth generates for each supported host.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Providers

Better Auth is the only Auth provider. ViteHub does not replace its storage, OAuth providers, or client plugins.

| Concern | Owner |
| --- | --- |
| Sign-in methods, OAuth providers, plugins | Better Auth options in the Auth Definition. |
| User and session storage | `authDatabase()`, which uses the app Database and adds the Better Auth tables to it, or a Better Auth database adapter that you return from the callback or `runtime`. |
| Route mounting | A generated Nitro handler, also in development when Nitro runs in the Vite dev server. In plain Vite development, `hubAuth()` serves the route. Manual hosts mount `#vitehub/auth/server`. |
| Roles and permissions | Your `authorize` callbacks. ViteHub defines no roles. |

## Provider output

Auth generates the Definition module, route handler, access middleware, and ambient types (`.vitehub/types/auth.d.ts`) that the host integration needs. Application code uses `@vite-hub/auth/server` or Better Auth clients, not generated files.

Set `route: false` only when a host integration or a manual route mounts the Auth handler itself.

```ts [server/auth.ts]
import { defineAuth } from '@vite-hub/auth'

export default defineAuth({
  appName: 'Acme',
  route: false,
})
```

The default export of `#vitehub/auth/server` is the Auth route as a Fetchable, `{ fetch(request) }`. Mount it below the same `basePath`:

```ts [server/routes/api/auth/[...].ts]
export { default } from '#vitehub/auth/server'
```

It reads the client address and the Cloudflare bindings from the [Standard Context](/docs/reference/runtime-context#standard-context) of the Request. Nitro sets it on each Request in a ViteHub app.
