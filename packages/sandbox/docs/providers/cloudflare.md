---
title: Cloudflare Sandbox
description: Configure @vitehub/sandbox to execute definitions through Cloudflare Sandbox.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro]
---

Use the Cloudflare provider when sandbox execution should run in Cloudflare's sandbox runtime.

Cloudflare needs two pieces: the `@cloudflare/sandbox` package and a Durable Object binding that ViteHub can resolve at runtime.

::steps{level="2"}

## Install the provider SDK

```bash
pnpm add @cloudflare/sandbox
```

## Configure Sandbox

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `sandbox.provider` to `cloudflare`:

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
Register the Nitro module and set `sandbox.provider` to `cloudflare`:

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

## Configure the binding

By default, ViteHub looks for a Cloudflare binding named `SANDBOX`.

Use `sandbox.binding` when your binding uses a different name:

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    provider: 'cloudflare',
    binding: 'MY_SANDBOX',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    provider: 'cloudflare',
    binding: 'MY_SANDBOX',
  },
})
```
::

The provider reads Cloudflare environment bindings from the request event. If the binding is missing, `runSandbox()` returns an error with this message:

```txt
Cloudflare sandbox requires the "SANDBOX" binding. Set sandbox.binding or run inside Cloudflare.
```

## Tune Cloudflare options

Cloudflare-specific options stay in the top-level provider config:

```ts
sandbox: {
  provider: 'cloudflare',
  binding: 'SANDBOX',
  className: 'Sandbox',
  migrationTag: 'v1',
  sleepAfter: '5m',
  keepAlive: true,
  normalizeId: true,
}
```

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `SANDBOX` | Binding name used to read the Durable Object namespace. |
| `className` | `Sandbox` | Generated Cloudflare sandbox class name. |
| `migrationTag` | `v1` | Migration tag used for the generated Durable Object config. |
| `sandboxId` | generated per call | Stable provider sandbox identity. |
| `sleepAfter` | provider default | Cloudflare sandbox sleep behavior. |
| `keepAlive` | provider default | Keep the sandbox alive when supported. |
| `normalizeId` | provider default | Normalize sandbox IDs when supported. |

::

## Verify the provider

Call a known sandbox route:

```bash
curl -X POST http://localhost:3000/api/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added Cloudflare provider"}'
```

Successful execution returns a normal Sandbox result:

```json
{
  "result": {
    "summary": "Added Cloudflare provider",
    "items": [
      "Added Cloudflare provider"
    ]
  }
}
```

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Sandbox provider could not be inferred` | No provider was configured and no Cloudflare environment was detected. | Set `sandbox.provider` to `cloudflare`. |
| `Cloudflare sandbox requires the "SANDBOX" binding` | The binding is missing from the request environment. | Add the binding or set `sandbox.binding` to the binding name you already use. |
| Provider package warning during build | `@cloudflare/sandbox` is not installed. | Run `pnpm add @cloudflare/sandbox`. |
