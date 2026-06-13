# @vite-hub/auth

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Better Auth" src="https://img.shields.io/badge/Better%20Auth-powered-0f766e?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-discovery-646cff?style=flat-square">
</p>

`@vite-hub/auth` defines one server-owned Auth Definition and turns it into a Better Auth server for ViteHub apps.

## Install

```sh
pnpm add @vite-hub/auth better-auth
```

## Minimal API

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth"

export default defineAuth({
  appName: "My app",
  database: true,
})
```

```ts
// vite.config.ts
import { hubAuth } from "@vite-hub/auth/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubAuth()],
})
```

```ts
// server/api/auth/[...].ts
import { auth } from "@vite-hub/auth/server"

export default auth.handler
```

## Vite Integration

Use `server/auth.ts` for the canonical Auth Definition, or `server.auth.ts` when a flat server file fits the project better. Vite discovers one Auth Definition, exposes it through an internal virtual module, and owns `/api/auth/**` in development by default.

Set `route: false` to opt out of automatic route exposure.

```ts
export default defineAuth({
  route: false,
})
```

Better Auth options stay top-level. ViteHub-owned runtime wiring uses reserved fields: `database`, `secondaryStorage`, `basePath`, and `route`. `baseURL`, `secret`, and `secrets` are runtime options and cannot be defined in `defineAuth()`.

```ts
export default defineAuth({
  basePath: "/auth",
  database: { name: "auth", dedicated: true },
  secondaryStorage: { store: "auth" },
})
```

Database and secondary storage placement are metadata in this first package layer. Runtime adapters are passed through `@vite-hub/auth/server` today and will be wired into the database and KV packages in follow-up iterations.

## Client-side Auth

Use Better Auth's client libraries from application code. ViteHub exposes the Auth route in local Vite development and provides the handler for hosts that mount it manually; Better Auth owns framework clients, hooks, client plugins, sign-in actions, and session state.

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/client"

export const authClient = createAuthClient()
```

That default talks to `/api/auth` on the same origin. If the Auth Definition uses a custom `basePath`, pass the same path to the Better Auth client.

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth"

export default defineAuth({
  appName: "My app",
  basePath: "/auth",
  database: true,
})
```

```ts
// lib/auth-client.ts
import { createAuthClient } from "better-auth/client"

export const authClient = createAuthClient({
  basePath: "/auth",
})
```

Use Better Auth's framework entrypoints when you want React, Vue, Svelte, Solid, or other framework-specific client behavior. ViteHub does not provide `@vite-hub/auth/client` or a separate Auth Client Definition.

Read [Better Auth's client docs](https://www.better-auth.com/docs/concepts/client) for framework entrypoints and session helpers.

## Authenticated Agents

Use `authenticated()` when an Agent should derive its Agent Invoker from the current Auth Session.

```ts
// server/support.agent.ts
import { defineAgent } from "@vite-hub/agent"
import { authenticated } from "@vite-hub/auth/agent"

export default defineAgent({
  invoker: authenticated(),
})
```

By default, the Auth Package reads the same-app Better Auth session from the request and maps the Auth User to an Agent Invoker with `kind: "authUser"`. Customize `id`, `kind`, `label`, or `meta` for normal identity shaping, and use `source` or `map` when the Agent consumes JWTs, bearer tokens, OAuth/OIDC provider output, or product-specific identity.
