---
title: Cloudflare Sandbox
description: Configure Sandbox for Cloudflare.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
frameworks: [vite, nitro]
---

Use the Cloudflare provider when sandbox execution should run through Cloudflare's sandbox runtime.

::steps{level="2"}

## Install the provider

```bash
pnpm add @cloudflare/sandbox
```

## Configure the provider

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    provider: 'cloudflare',
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
    provider: 'cloudflare',
  },
})
```
::

::

## Runtime notes

Keep the sandbox definition and `runSandbox()` call provider-neutral. Provider-specific setup belongs in app config and deployment configuration.

## Related pages

- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
