---
title: Vercel Sandbox
description: Configure @vitehub/sandbox to execute definitions through Vercel Sandbox.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use the Vercel provider when sandbox execution should run through Vercel Sandbox.

Vercel needs the `@vercel/sandbox` package and project credentials. Credentials can come from environment variables or explicit provider config.

::steps{level="2"}

## Install the provider SDK

```bash
pnpm add @vercel/sandbox
```

## Configure Sandbox

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `sandbox.provider` to `vercel`:

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
Register the Nitro module and set `sandbox.provider` to `vercel`:

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

## Add credentials

Set the plain Vercel environment variables:

```bash
VERCEL_TOKEN=<vercel-token>
VERCEL_TEAM_ID=<vercel-team-id>
VERCEL_PROJECT_ID=<vercel-project-id>
```

Framework-prefixed names are also supported:

| Runtime | Token | Team | Project |
| --- | --- | --- | --- |
| Nitro | `NITRO_SANDBOX_TOKEN` | `NITRO_SANDBOX_TEAM_ID` | `NITRO_SANDBOX_PROJECT_ID` |
| Nuxt | `NUXT_SANDBOX_TOKEN` | `NUXT_SANDBOX_TEAM_ID` | `NUXT_SANDBOX_PROJECT_ID` |
| Vite | `VITE_SANDBOX_TOKEN` | `VITE_SANDBOX_TEAM_ID` | `VITE_SANDBOX_PROJECT_ID` |

You can also pass credentials in config:

```ts
sandbox: {
  provider: 'vercel',
  token: process.env.VERCEL_TOKEN,
  teamId: process.env.VERCEL_TEAM_ID,
  projectId: process.env.VERCEL_PROJECT_ID,
}
```

## Tune Vercel options

```ts
sandbox: {
  provider: 'vercel',
  runtime: 'node22',
  timeout: 30_000,
  cpu: 2,
  ports: [3000],
}
```

| Option | Description |
| --- | --- |
| `runtime` | Vercel sandbox runtime image. Use `node22` or `node24`. |
| `timeout` | Execution timeout in milliseconds. |
| `cpu` | CPU allocation passed to Vercel Sandbox. |
| `ports` | Ports exposed by the sandbox when needed. |
| `source` | Vercel sandbox source configuration. |
| `networkPolicy` | Vercel sandbox network policy. |

::

## Verify the provider

Call a known sandbox route:

```bash
curl -X POST http://localhost:3000/api/release-notes \
  -H 'content-type: application/json' \
  -d '{"notes":"- Added Vercel provider"}'
```

Successful execution returns a normal Sandbox result:

```json
{
  "result": {
    "summary": "Added Vercel provider",
    "items": [
      "Added Vercel provider"
    ]
  }
}
```

## Common failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `Sandbox provider could not be inferred` | No provider was configured and Vercel was not detected. | Set `sandbox.provider` to `vercel`. |
| Vercel sandbox cannot create a runtime | Credentials are missing or incomplete. | Set token, team ID, and project ID through env vars or config. |
| Provider package warning during build | `@vercel/sandbox` is not installed. | Run `pnpm add @vercel/sandbox`. |
