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

`hubAuth()` discovers `server/auth.ts`, exposes `/api/auth/**`, and generates the Nitro route handler for production builds.

For host routes that need runtime secrets, provider credentials, request-derived origins, or route guarding, keep that policy in the Auth Definition.

```ts
// vite.config.ts
import { hubAuth } from "@vite-hub/auth/vite"
import { env, hubEnv } from "@vite-hub/env/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    hubEnv(),
    hubAuth(),
  ],
  env: {
    server: {
      auth: {
        github: {
          clientId: env({ source: env.source("GITHUB_CLIENT_ID") }),
          clientSecret: env({ secret: true, source: env.source("GITHUB_CLIENT_SECRET") }),
        },
        secret: env({ secret: true, source: env.source("BETTER_AUTH_SECRET") }),
      },
    },
  },
})
```

```ts
// server/auth.ts
import { defineAuth } from "@vite-hub/auth"

export default defineAuth(({ env, requestOrigin }) => ({
  appName: "My app",
  baseURL: requestOrigin,
  secret: env.auth.secret.unseal(),
  access: {
    routes: ["/app", "/app/**"],
    signIn: {
      provider: "github",
      callbackURL: "/app",
      errorCallbackURL: "/app?auth_error=github",
    },
  },
  socialProviders: {
    github: {
      clientId: env.auth.github.clientId,
      clientSecret: env.auth.github.clientSecret.unseal(),
    },
  },
}))
```

When `@vite-hub/env` is installed, the Auth Definition callback receives the typed server env. It also receives `requestOrigin`, so same-origin apps do not need a separate auth URL environment variable.

The generated Nitro middleware uses `access.signIn` when one of the configured `access.routes` needs a browser redirect.

## Vite Integration

Use `server/auth.ts` for the canonical Auth Definition, or `server.auth.ts` when a flat server file fits the project better. Vite discovers one Auth Definition, exposes it through an internal virtual module, owns `/api/auth/**` in development, and registers the same route with Nitro builds by default.

Set `route: false` only when a host integration mounts Auth itself.

```ts
export default defineAuth({
  route: false,
})
```

Manual hosts can mount the stable `#vitehub/auth/server` handler directly.

Better Auth options stay top-level. ViteHub-owned wiring reserves `access`, `database`, `secondaryStorage`, `basePath`, `route`, and `runtime`. The Better Auth fields `baseURL`, `secret`, and `secrets` are runtime-only: return them from the Definition callback or place them under `runtime`. `access.routes` must be static route strings or `{ method, route }` objects so the Vite Integration can register Nitro middleware.

```ts
export default defineAuth({
  basePath: "/auth",
  database: { name: "auth", dedicated: true },
  secondaryStorage: { store: "auth" },
})
```

`database` and `secondaryStorage` are placement metadata. ViteHub removes metadata-shaped values before calling `betterAuth()`, so they do not create Database or KV adapters. When Better Auth needs persistent storage, return its concrete `database` or `secondaryStorage` adapter from the Definition callback or `runtime`.

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
  driver: {
    run: ({ invoker }) => ({ invoker }),
  },
})
```

By default, the Auth Package reads the same-app Better Auth session from the request and maps the Auth User to an Agent Invoker with `kind: "authUser"`. Customize `id`, `kind`, `label`, or `meta` for normal identity shaping, and use `source` or `map` when the Agent consumes JWTs, bearer tokens, OAuth/OIDC provider output, or product-specific identity.

When authentication is required but unavailable, `authenticated()` throws `ViteHubError` with code `AUTHENTICATION_REQUIRED`. HTTP adapters map that code to `401`; the transport status is not part of the error object.

```ts
import { ViteHubError } from "@vite-hub/runtime"

const error = new ViteHubError("AUTHENTICATION_REQUIRED", "Sign in to use this Agent.")
```

`error.toJSON()` includes `name`, `code`, and `message`, while omitting `cause` and stack data. If a default Better Auth request or session operation fails, `authenticated()` and `requireAuth()` throw the same shared error with code `AUTH_PROVIDER_OPERATION_FAILED` and safe operation details; raw provider diagnostics remain available only through `cause`. Existing ViteHub errors and structural `AbortError` objects keep their identity. Missing APIs, malformed responses, invalid Auth configuration, and invalid custom callback results are programmer or provider-contract defects, so ViteHub keeps those `TypeError`s outside the operational provider boundary.
