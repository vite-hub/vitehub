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

## External runtime values

Use a read-only Env provider when application credentials live outside the host environment. Keep the provider's bootstrap credential in Kubernetes, Cloudflare, or the current host, then load the external values as one operation-scoped snapshot.

```ts
// vite.config.ts
import { env, hubEnv } from "@vite-hub/env/vite"

export default {
  plugins: [hubEnv({
    providers: { credentials: "./server/env/credentials.ts" },
  })],
  env: {
    server: {
      gatewayKey: env({ secret: true }),
      githubToken: env({
        secret: true,
        source: env.provider("credentials", "github/token"),
      }),
    },
  },
}
```

```ts
// server/env/credentials.ts
import { defineEnvProvider } from "@vite-hub/env/provider"
import type { SecretEnv } from "@vite-hub/env/secret"

export default defineEnvProvider<{ gatewayKey: SecretEnv<string> }>({
  async read({ env, keys, signal }) {
    const response = await fetch("https://credentials.internal/env", {
      headers: { authorization: `Bearer ${env.gatewayKey.unseal()}` },
      signal,
    })
    const values = await response.json() as Record<string, string | undefined>
    return Object.fromEntries(keys.map(key => [key, values[key]]))
  },
})
```

```ts
import { loadServerEnv } from "#vitehub/env/server"

const snapshot = await loadServerEnv()
const githubToken = snapshot.githubToken.unseal()
```

Each `loadServerEnv()` call batches requested keys once per provider and returns a fresh frozen snapshot. ViteHub does not cache across loads, so rotation appears on the next load. `useServerEnv()` stays synchronous for host-backed and literal values; provider-backed values require `loadServerEnv()` or `runWithServerEnv()`.

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
