---
title: Deno
description: Generate Deno server output for Agent routes and Schedule wake output without making app code Deno-specific.
navigation.order: 46
navigation.group: Deployment hosts
icon: i-simple-icons-deno
---

Use the `deno` preset to deploy a ViteHub application to Deno Deploy. Nitro
builds the server at `.output/server/index.mjs`. Agent Definitions, Schedule
Definitions, KV Stores, and Runtime Helpers stay portable; Deno-specific code
stays in generated output and driver configuration.

## Deno boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Agent chat and webhook routes | The Nitro server mounts the conventional chat dispatcher and webhook route. Route-enabled Channels select which Agents answer chat requests. |
| Static cron schedules | The Schedule integration writes `.vitehub/schedule/deno-cron.mjs` for Deno `Deno.cron` wake output. `vitehub({ schedule })` fails on this preset, so add `hubSchedule()` directly. |
| Lightweight state | KV defaults to `driver: 'deno-kv'` and native `Deno.openKv()`. |
| Not available | Blob without an explicit store, Queue, Rate Limit, and Sandbox fail the build. |
| Deployment | Deno Deploy owns environment variables, permissions, logs, and production rollout. |

The Agent integration option `runtime: 'deno'` writes a separate
`.vitehub/agent/deno-server.ts`. The `deno` preset rejects that option because
the separate server is outside the deployed Nitro entry.

## Configure the preset

Select the `deno` preset. This example also adds static Schedule output, so
install the Schedule owner package first.

```bash [Terminal]
pnpm add @vite-hub/schedule
```

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'deno',
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

The generated Nitro server imports discovered Agent Definitions and mounts both the webhook route pattern and the conventional `/api/_vitehub/agents/[agent]/chat` dispatcher.
Schedule output needs a project-root `main.ts` that registers the cron output before it starts the server. The build bundles this file into `.output/main.ts` and fails when the file is missing.

```ts [main.ts]
await import(new URL('./schedule/deno-cron.mjs', import.meta.url).href)
await import(new URL('./server/index.mjs', import.meta.url).href)
```

## Generated output

A production build stages the Deno server, the `main.ts` entrypoint, and Schedule output under `.output`. Without `main.ts`, the entrypoint is `.output/server/index.mjs`.

```bash [Terminal]
pnpm build
test -f .output/server/index.mjs
test -f .output/main.ts
find .output -maxdepth 4 -type f | sort
```

Pin the generated Deno Deploy server to port `8000` so inherited shell variables cannot change the documented address.

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 NITRO_HOST=0.0.0.0 NITRO_PORT=8000 deno run --unstable-cron --allow-env --allow-read=.output --allow-net .output/main.ts
```

A route using `driver: 'deno-kv'` also requires Deno KV support.

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 NITRO_HOST=0.0.0.0 NITRO_PORT=8000 deno run --unstable-cron --unstable-kv --allow-env --allow-read=.output --allow-net .output/main.ts
```

For a single discovered `support` Agent with the default chat route enabled, the generated route accepts the following request. The target Agent must attach a route-enabled `webChat()` Channel; Agents without one remain unreachable through the dispatcher.

```bash [Terminal]
curl -X POST http://127.0.0.1:8000/api/_vitehub/agents/support/chat \
  -H 'content-type: application/json' \
  -d '{"id":"local","messages":[{"id":"user-1","role":"user","parts":[{"type":"text","text":"ping"}]}]}'
```

## Production notes

Deno Deploy uses the staged `.output/main.ts` as the application entrypoint when it exists. It registers generated static schedules before starting `.output/server/index.mjs`.
Keep generated-file imports confined to this deployment entrypoint. Agent Definitions and other application code should use Runtime Helpers and stable ViteHub imports.

Use Deno environment variables for model keys and other Runtime Env.
If you use Deno KV, verify the deployed runtime can call `Deno.openKv()` and choose an explicit KV Store when local development must not share production state.
On Deno Deploy, create a KV database and assign it to the app before the first deploy that uses it. ViteHub Provision does not create it; see [Resources without provisioning](/docs/development/provisioning#resources-without-provisioning).

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the qualified host boundary.
- Use [Provider output](/docs/reference/provider-output) for generated artifact boundaries.
- Use [Generated files](/docs/development/generated-files) to inspect `.vitehub/**`.
- Use [Config options](/docs/reference/config-options) for Agent `runtime` and KV `driver` placement.
