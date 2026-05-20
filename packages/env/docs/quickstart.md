---
title: Env quickstart
description: Declare one Vite build value, one Nitro runtime secret, and verify both outputs.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite, nitro]
---

This guide shows the two Env paths:

- Public Env values exposed through `#vitehub/env/public`
- Server Env values exposed through `#vitehub/env/server`

::code-collapse

```txt [Prompt]
Set up @vitehub/env in this app.

- Install @vitehub/env
- Register envVite() or envNitro()
- Declare a public build value
- Declare a server-only Runtime Env secret
- Read generated Public Env and Server Env from app code

Docs: /docs/vite/env/quickstart or /docs/nitro/env/quickstart
```

::

::steps

### Install Env

```bash
pnpm add @vitehub/env
```

### Register the integration

::fw{id="vite:dev vite:build"}
Register `envVite()` and declare a public build value:

```ts [vite.config.ts]
import { env, envVite } from '@vitehub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [envVite({ prefix: 'VITEHUB_' })],
  env: {
    public: {
      appName: env({
        default: 'ViteHub Env',
        mode: 'build',
      }),
    },
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and declare a server-only secret:

```ts [nitro.config.ts]
import { env, envNitro } from '@vitehub/env/nitro'
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: [envNitro()],
  env: {
    auth: {
      token: env({
        secret: true,
      }),
    },
  },
})
```
::

### Read Env values

::fw{id="vite:dev vite:build"}
Read Public Env from the ViteHub public env import path:

```ts [src/main.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()

document.querySelector('#app')!.textContent = publicEnv.appName
```
::

::fw{id="nitro:dev nitro:build"}
Read Server Env from the Nitro server helper:

```ts [server/api/config.get.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  const env = useServerEnv(event)

  return {
    hasAuthToken: Boolean(env.auth.token),
  }
})
```
::

### Verify the result

::fw{id="vite:dev vite:build"}
Set a prefixed value and start Vite:

```bash
VITEHUB_APP_NAME="Docs App" pnpm dev
```

The rendered page should show `Docs App`.
::

::fw{id="nitro:dev nitro:build"}
Set the runtime secret and start Nitro:

```bash
AUTH_TOKEN="local-secret" pnpm dev
```

Read the config route:

```bash
curl http://localhost:3000/api/config
```

Expected response:

```json
{
  "hasAuthToken": true
}
```
::

::

## Next steps

- Use [Usage](./usage) for defaults, optional values, explicit sources, schemas, and diagnostics.
- Use [Runtime API](./runtime-api) for exact declaration shapes.
- Use [Troubleshooting](./troubleshooting) if generated types or runtime values are missing.
