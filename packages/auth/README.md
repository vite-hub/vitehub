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
