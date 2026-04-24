---
title: Vercel Sandbox
description: Configure Sandbox for Vercel.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
frameworks: [vite, nitro]
---

Use the Vercel provider when sandbox execution should run through Vercel Sandbox.

::steps{level="2"}

## Install the provider

```bash
pnpm add @vercel/sandbox
```

## Configure the provider

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    provider: 'vercel',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    provider: 'vercel',
  },
})
```
::

## Credentials

Vercel can resolve credentials from explicit config or environment variables:

```bash
VERCEL_TOKEN=<vercel-token>
VERCEL_TEAM_ID=<vercel-team-id>
VERCEL_PROJECT_ID=<vercel-project-id>
```

::

## Related pages

- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
