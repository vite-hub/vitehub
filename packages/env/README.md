# @vite-hub/env

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-public%20env-646cff?style=flat-square">
</p>

`@vite-hub/env` declares environment values once, then generates typed public and server env access.

## Install

```sh
pnpm add @vite-hub/env
```

## Minimal API

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubEnv({ prefix: "VITEHUB_" })],
  env: {
    public: {
      appName: env({ default: "ViteHub App", mode: "build" }),
    },
    server: {
      airtableToken: env({ secret: true }),
    },
  },
})
```

```ts
// app/env.ts
import { publicEnv } from "#vitehub/env/public"

export const appName = publicEnv.appName
```

```ts
// server/sync.ts
import { runWithServerEnv, useServerEnv } from "#vitehub/env/server"

export async function sync(event: unknown) {
  return runWithServerEnv(event, async () => {
    const { airtableToken } = useServerEnv()
    await fetch("https://api.airtable.com/v0/app/table", {
      headers: { Authorization: `Bearer ${airtableToken.unseal()}` },
    })
  })
}
```

## Vite Integration

Use `hubEnv()` in Vite to resolve public/build env, generate `#vitehub/env/public` and `#vitehub/env/server`, and keep environment declarations close to the app config. Runtime secrets are read from the host environment at request time and are wrapped in `SecretEnv` until explicitly unsealed. `runWithServerEnv(event, callback)` activates host Runtime Env for nested ViteHub runtime helpers that cannot receive the request or scheduled event directly.

`hubEnv()` writes generated env runtime modules to `.vitehub/env/` and generated env types to `.vitehub/types/env.d.ts`. Add `.vitehub/types/**/*.d.ts` to your `tsconfig.json` include list when TypeScript should see app-specific Public Env and Server Env fields.

Learn more at [vitehub.dev](https://vitehub.dev).
