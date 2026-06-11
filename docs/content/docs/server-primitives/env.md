---
title: Env
description: Model Vite build-time and public values without leaking secrets across boundaries.
navigation.order: 3
icon: i-lucide-key-round
---

Env is the server primitive for typed build-time values. Use it when the app needs clear boundaries between public client values, compile-time replacements, and secrets.

## What Env owns

Env owns:

- Public Env values that may be exposed to the client.
- Compile-time replacements through Vite define values.
- Public access through stable ViteHub imports.

Env does not own secret storage for each host. The host still supplies environment variables. ViteHub gives the app a typed build layer.

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
  },
})
```

Use the generated public import from client or server code:

```ts [src/config.ts]
import { usePublicEnv } from '#vitehub/env/public'

const env = usePublicEnv()

export const appName = env.appName
```

## Secrets

Do not put secrets in `env.public` or `env.define`; Vite bundles those values. Keep server-only secrets in the host runtime and pass them to the server primitive that needs them.

## Host environment behavior

Cloudflare and Vercel both provide environment variables, but their dashboards, local development files, and preview behavior differ. Keep those differences in deployment setup. Application code should keep using the generated public import and explicit Vite define values.
