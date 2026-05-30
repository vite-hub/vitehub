# @vite-hub/env

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-public%20env-646cff?style=flat-square">
  <img alt="Nitro" src="https://img.shields.io/badge/Nitro-server%20env-00dc82?style=flat-square">
</p>

`@vite-hub/env` declares environment values once, then generates typed public and server env access.

## Install

```sh
pnpm add @vite-hub/env
```

## Minimal API

```ts
// vite.config.ts
import { env, envVite } from "@vite-hub/env/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [envVite({ prefix: "VITEHUB_" })],
  env: {
    public: {
      appName: env({ default: "ViteHub App", mode: "build" }),
    },
  },
})
```

```ts
// nitro.config.ts
import { env, envNitro } from "@vite-hub/env/nitro"
import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: [envNitro()],
  env: {
    auth: {
      token: env({ secret: true }),
    },
  },
})
```

```ts
// server/api/config.get.ts
import { useServerEnv } from "#vitehub/env/server"
import { defineEventHandler } from "h3"

export default defineEventHandler((event) => {
  const env = useServerEnv(event)

  return {
    hasAuthToken: Boolean(env.auth.token.unseal()),
  }
})
```

## Vite and Nitro

Vite handles public/build env and generates `#vitehub/env/public`. Nitro handles server/runtime env, secret values, and `#vitehub/env/server`. Cloudflare secrets can be marked as required during Nitro setup.

Learn more at [vitehub.dev](https://vitehub.dev).
