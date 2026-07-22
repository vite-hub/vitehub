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
import { useServerEnv } from "#vitehub/env/server"

export async function sync(event: unknown) {
  const { airtableToken } = useServerEnv(event)

  await fetch("https://api.airtable.com/v0/app/table", {
    headers: { Authorization: `Bearer ${airtableToken.unseal()}` },
  })
}
```

## Structured errors

ViteHub-owned Env resolution failures use the shared `ViteHubError` contract with Env-specific codes. Custom source resolvers keep application-owned errors unchanged, so callers can preserve their own error contract without translating it through ViteHub.

```ts
import { getViteHubErrorShape } from "@vite-hub/runtime"

try {
  await resolveVaultEnv()
}
catch (error) {
  if (getViteHubErrorShape(error)?.code === "ENV_SOURCE_FAILED") {
    console.error("Env source failed")
  }
  throw error
}
```

Each `EnvErrorCode` owns a fixed public message and a bounded details shape. Source details use stable identifiers such as `git:branch`, `package.json`, `env`, or `custom`; raw variable names, package paths, and provider diagnostics stay behind `cause`, which `toJSON()` omits. Cancellation and existing `ViteHubError` instances pass through unchanged. Invalid `env()` calls remain `TypeError`, and `parseSchema()` keeps the schema library's ordinary error boundary.

## Vite Integration

Use `hubEnv()` in Vite to resolve public/build env, generate `#vitehub/env/public` and `#vitehub/env/server`, and keep environment declarations close to the app config. Runtime secrets are read from the host environment at request time and are wrapped in `SecretEnv` until explicitly unsealed.

`hubEnv()` writes generated env runtime modules to `.vitehub/env/` and generated env types to `.vitehub/types/env.d.ts`. Add `.vitehub/types/**/*.d.ts` to your `tsconfig.json` include list when TypeScript should see app-specific Public Env and Server Env fields.

For hosts that do not consume Vite plugin aliases directly, compose the generated modules explicitly:

```ts
import { createEnvImportAliases, createEnvTypeScriptPaths, hubEnv } from "@vite-hub/env/vite"

export default {
  nitro: {
    alias: createEnvImportAliases(),
  },
  typescript: {
    tsConfig: {
      compilerOptions: {
        paths: createEnvTypeScriptPaths({ relativeTo: ".nuxt" }),
      },
    },
  },
  vite: {
    plugins: [hubEnv()],
  },
}
```

Learn more at [vitehub.dev](https://vitehub.dev).
