---
title: Env
description: Model public, build-time, and server runtime values without leaking secrets across boundaries.
navigation.order: 3
icon: i-lucide-key-round
---

Env is the server primitive for typed environment values. Use it when the app needs clear boundaries between public client values, compile-time replacements, and server runtime secrets.

## What Env owns

Env owns:

- Public Env values that may be exposed to the client.
- Compile-time replacements through Vite define values.
- Server Env values read from the host runtime.
- Public and server access through stable ViteHub imports.

Env does not own secret storage for each host. The host still supplies environment variables. ViteHub gives the app typed access and wraps Secret Env values until server code explicitly unseals them.

## Minimal setup

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme' }),
    },
    define: {
      __BUILD_TARGET__: env({ default: 'preview' }),
    },
    server: {
      airtableToken: env({ secret: true }),
    },
  },
})
```

Use the generated public import from client or server code:

```ts [src/config.ts]
import { usePublicEnv } from '#vitehub/env/public'

const env = usePublicEnv()

export const appName = env.appName
```

Use the generated server import from server-only code:

```ts [server/sync.ts]
import { useServerEnv } from '#vitehub/env/server'

export async function syncAirtable() {
  const { airtableToken } = useServerEnv()

  await fetch('https://api.airtable.com/v0/app/table', {
    headers: { Authorization: `Bearer ${airtableToken.unseal()}` },
  })
}
```

## TypeScript names

`hubEnv()` writes generated Public Env and Server Env runtime modules to `.vitehub/env/` and generated types to `.vitehub/types/env.d.ts`. Add that generated type directory to your `tsconfig.json` when you want `#vitehub/env/public` and `#vitehub/env/server` to expose app-specific fields.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

Hosts that generate their own TypeScript config or server bundler aliases can use the package-owned path helpers instead of hardcoding `.vitehub` file paths:

```ts [nuxt.config.ts]
import { createEnvImportAliases, createEnvTypeScriptPaths, hubEnv } from '@vite-hub/env/vite'

export default defineNuxtConfig({
  nitro: {
    alias: createEnvImportAliases(),
  },
  typescript: {
    tsConfig: {
      compilerOptions: {
        paths: createEnvTypeScriptPaths({ relativeTo: '.nuxt' }),
      },
    },
  },
  vite: {
    plugins: [hubEnv()],
  },
})
```

## Secrets

Do not put secrets in `env.public` or `env.define`; Vite bundles those values. Put server-only secrets in `env.server` with `secret: true`, then unseal the generated `SecretEnv` value at the boundary that needs the raw string.

## Host environment behavior

Cloudflare and Vercel both provide environment variables, but their dashboards, local development files, and preview behavior differ. Keep those differences in deployment setup. Application code should keep using generated Public Env, Server Env, and explicit Vite define values.
