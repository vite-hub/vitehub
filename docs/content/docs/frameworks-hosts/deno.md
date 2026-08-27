---
title: Deno
description: Generate Deno server output for Agent routes and Schedule wake output without making app code Deno-specific.
navigation.order: 46
icon: i-simple-icons-deno
---

Deno is an Agent Package runtime target and a host boundary for Deno-shaped Provider Output.
ViteHub keeps Agent Definitions, Schedule Definitions, KV Stores, and Runtime Helpers portable; Deno-specific code stays in generated output and driver configuration.

## Deno boundaries

| Concern | ViteHub boundary |
| --- | --- |
| Agent chat and webhook routes | Agent Package writes `.vitehub/agent/deno-server.ts` when `runtime: 'deno'` and hosted Agent Definitions exist. It mounts the conventional chat dispatcher and webhook route; route-enabled Channels select which Agents answer chat requests. |
| Static cron schedules | Schedule Package writes `.vitehub/schedule/deno-cron.mjs` for Deno `Deno.cron` wake output. |
| Lightweight state | KV Package can use `driver: 'deno-kv'` and native `Deno.openKv()`. |
| Deployment | Deno Deploy owns app entrypoint configuration, environment variables, permissions, logs, and production rollout. |

## Deno output boundary

The Agent integration selects Deno when generated Agent routes run through `Deno.serve`. Other primitives retain their package-owned runtime options.

```ts [vite.config.ts]
import { hubSchedule } from '@vite-hub/schedule/vite'
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'deno',
      agent: true,
      kv: {
        driver: 'deno-kv',
      },
    }),
    hubSchedule({ providerOutput: 'standalone' }),
    nitro() as never,
  ],
})
```

The generated Nitro server imports discovered Agent Definitions and mounts both the webhook route pattern and the conventional `/api/_vitehub/agents/[agent]/chat` dispatcher.
Schedule keeps its package-owned `.vitehub/schedule/deno-cron.mjs` output. Use one application entrypoint to register that output before starting the server.

```ts [main.ts]
await import(new URL('./schedule/deno-cron.mjs', import.meta.url).href)
await import(new URL('./server/index.mjs', import.meta.url).href)
```

## Generated output

A production-shaped build stages the Deno server, application entrypoint, and Schedule output under `.output`.

```bash [Terminal]
pnpm build
test -f .output/server/index.mjs
test -f .output/main.ts
find .output -maxdepth 4 -type f | sort
```

Pin the generated Deno Deploy server to port `8000` so inherited shell variables cannot change the documented address.

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 deno run --unstable-cron --allow-env --allow-read=.output --allow-net .output/main.ts
```

A route using `driver: 'deno-kv'` also requires Deno KV support.

```bash [Terminal]
HOST=0.0.0.0 PORT=8000 deno run --unstable-cron --unstable-kv --allow-env --allow-read=.output --allow-net .output/main.ts
```

For a single discovered `support` Agent with the default chat route enabled, the generated route accepts the following request. The target Agent must attach a route-enabled `webChat()` Channel; Agents without one remain unreachable through the dispatcher.

```bash [Terminal]
curl -X POST http://127.0.0.1:8000/api/_vitehub/agents/support/chat \
  -H 'content-type: application/json' \
  -d '{"id":"local","messages":[{"id":"user-1","role":"user","parts":[{"type":"text","text":"ping"}]}]}'
```

## Production notes

Deno Deploy uses the staged `.output/main.ts` as the application entrypoint. It registers generated static schedules before starting `.output/server/index.mjs`.
Keep generated-file imports confined to this deployment entrypoint. Agent Definitions and other application code should use Runtime Helpers and stable ViteHub imports.

Use Deno environment variables for model keys and other Runtime Env.
If you use Deno KV, verify the deployed runtime can call `Deno.openKv()` and choose an explicit KV Store when local development must not share production state.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the qualified host boundary.
- Use [Provider output](/docs/reference/provider-output) for generated artifact boundaries.
- Use [Generated files](/docs/development/generated-files) to inspect `.vitehub/**`.
- Use [Config options](/docs/reference/config-options) for Agent `runtime` and KV `driver` placement.
