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
// app/env.ts
import { publicEnv } from "#vitehub/env/public"

export const appName = publicEnv.appName
```

## Vite Integration

Use `envVite()` in Vite to resolve public/build env, generate `#vitehub/env/public`, and keep environment declarations close to the app config.

Learn more at [vitehub.dev](https://vitehub.dev).
