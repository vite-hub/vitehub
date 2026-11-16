---
title: Deno
description: Generate Deno server output for Agent routes and Schedule wake output without making app code Deno-specific.
navigation.order: 46
navigation.group: Deployment hosts
icon: i-simple-icons-deno
---

The `deno` host deploys your app to Deno Deploy. Nitro builds the server at
`.output/server/index.mjs`. Definitions, KV Stores, and Runtime Helpers stay
portable. Deno code stays in generated output and driver configuration.

## Deno boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Agent chat and webhook routes | The Nitro server mounts the standard chat dispatcher and webhook route. Route-enabled Channels pick which Agents answer chat requests. |
| Static cron schedules | The Schedule integration writes `.vitehub/schedule/deno-cron.mjs` for `Deno.cron` wake output. `vitehub({ schedule })` fails on this host, so add `hubSchedule()` directly. |
| Lightweight state | KV defaults to `driver: 'deno-kv'` and native `Deno.openKv()`. |
| Not available | Blob without an explicit store, Queue, Rate Limit, and Sandbox fail the build. |
| Deployment | Deno Deploy owns environment variables, permissions, logs, and rollout. |

The Agent option `runtime: 'deno'` writes a separate
`.vitehub/agent/deno-server.ts`. The `deno` host rejects it, because that
server is outside the deployed Nitro entry.

## Configure the host

Select the `deno` host. This example also adds static Schedule output, so
install the Schedule package first.

```bash [Terminal]
pnpm add @vite-hub/schedule
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'deno',
    agent: true,
    console: false,
    workflow: false,
    kv: {
      driver: 'deno-kv',
    },
  },
})
```

> [!WARNING]
> In Nuxt, ViteHub does not write the `Deno.cron` output yet, so static Schedules do not run on Deno. Use the Nitro or Vite setup when you need them.
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'deno',
      agent: true,
      console: false,
      workflow: false,
      kv: {
        driver: 'deno-kv',
      },
    }),
    nitro(),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'deno',
      agent: true,
      console: false,
      workflow: false,
      kv: {
        driver: 'deno-kv',
      },
    }),
    hubSchedule({ providerOutput: 'standalone' }),
  ],
})
```
:::
::

The generated Nitro server imports your Agent Definitions and mounts the webhook route pattern and the standard `/api/_vitehub/agents/[agent]/chat` dispatcher.
Schedule output needs a `main.ts` in the project root that registers the cron output before it starts the server. The build bundles it into `.output/main.ts` and fails without it.

```ts [main.ts]
await import(new URL('./schedule/deno-cron.mjs', import.meta.url).href)
await import(new URL('./server/index.mjs', import.meta.url).href)
```

## Generated output

A production build puts the Deno server, the `main.ts` entrypoint, and Schedule output under `.output`. Without `main.ts`, the entrypoint is `.output/server/index.mjs`.

```bash [Terminal]
pnpm build
test -f .output/server/index.mjs
test -f .output/main.ts
find .output -maxdepth 4 -type f | sort
```

Pin the server to port `8000` so shell variables cannot change the address.

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 NITRO_HOST=0.0.0.0 NITRO_PORT=8000 deno run --unstable-cron --allow-env --allow-read=.output --allow-net .output/main.ts
```

A route that uses `driver: 'deno-kv'` also needs Deno KV support:

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 NITRO_HOST=0.0.0.0 NITRO_PORT=8000 deno run --unstable-cron --unstable-kv --allow-env --allow-read=.output --allow-net .output/main.ts
```

For one `support` Agent with the default chat route, the generated route accepts this request. The Agent must attach a route-enabled `webChat()` Channel. The dispatcher cannot reach Agents without one.

```bash [Terminal]
curl -X POST http://127.0.0.1:8000/api/_vitehub/agents/support/chat \
  -H 'content-type: application/json' \
  -d '{"id":"local","messages":[{"id":"user-1","role":"user","parts":[{"type":"text","text":"ping"}]}]}'
```

## Production notes

When `.output/main.ts` exists, Deno Deploy uses it as the entrypoint. It registers the static schedules, then starts `.output/server/index.mjs`.
Import generated files only in this entrypoint. Agent Definitions and other app code use Runtime Helpers and stable ViteHub imports.

- Put model keys and other Runtime Env in Deno environment variables.
- With Deno KV, check that the deployed runtime can call `Deno.openKv()`. Set an explicit KV Store when local development must not share production state.
- On Deno Deploy, create a KV database and assign it to the app before the first deploy that uses it. ViteHub Provision does not create it; see [Resources without provisioning](/docs/development/provisioning#resources-without-provisioning).

## Next steps

- See [Runtime and host support](/docs/frameworks-hosts/support-matrix) for host limits.
- See [Provider output](/docs/reference/provider-output) for generated files.
- See [Generated files](/docs/development/generated-files) to inspect `.vitehub/**`.
- See [Config options](/docs/reference/config-options) for Agent `runtime` and KV `driver`.
