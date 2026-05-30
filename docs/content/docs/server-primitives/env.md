---
title: Env
description: Model public and server-only runtime values without leaking secrets across boundaries.
navigation.order: 3
icon: i-lucide-key-round
---

Env is the server primitive for typed runtime values. Use it when the app needs clear boundaries between public values, server-only values, and secrets.

## What Env owns

Env owns:

- Public Env values that may be exposed to the client.
- Server Env values that stay server-only.
- Secret values that should redact by default in logs, traces, and DevTools.
- Runtime access through stable ViteHub imports.

Env does not own secret storage for each host. The host still supplies environment variables. ViteHub gives the app a typed, redaction-aware access layer.

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
    server: {
      authToken: env({ secret: true }),
    },
  },
})
```

Use the generated server import from server code:

```ts [server/api/config.get.ts]
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  const env = useServerEnv(event)
  return {
    appName: env.public.appName,
    hasToken: Boolean(env.server.authToken),
  }
})
```

## Secrets

Secrets should be unsealed only at the edge where they are needed.

```ts
const token = env.server.authToken.unseal()
```

Keep sealed values in structured logs and runtime metadata. That gives DevTools enough shape to explain what exists without exposing credentials.

## Runtime environment behavior

Cloudflare and Vercel both provide environment variables, but their dashboards, local development files, and preview behavior differ. Keep those differences in deployment setup. Application code should keep using `useServerEnv()`.
