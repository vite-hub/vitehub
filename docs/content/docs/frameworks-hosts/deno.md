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
      kv: {
        driver: 'deno-kv',
      },
    }),
    hubSchedule(),
    nitro() as never,
  ],
})
```

The generated Nitro server imports discovered Agent Definitions and mounts both the webhook route pattern and the conventional `/api/_vitehub/agents/[agent]/chat` dispatcher.
Schedule keeps its package-owned `.vitehub/schedule/deno-cron.mjs` output.

## Generated output

A production-shaped build writes the Deno server under `.output` and Schedule output under `.vitehub`.

```bash [Terminal]
pnpm build
test -f .output/server/index.mjs
find .output .vitehub -maxdepth 4 -type f | sort
```

The generated server runs locally with Deno network permission for the selected port.

```bash [Terminal]
deno run --allow-net=127.0.0.1:8787 .output/server/index.mjs
```

A route using `driver: 'deno-kv'` also requires Deno KV support.

```bash [Terminal]
deno run --unstable-kv --allow-net=127.0.0.1:8787 .output/server/index.mjs
```

For a single discovered `support` Agent with the default chat route enabled, the generated route accepts the following request. The target Agent must attach a route-enabled `webChat()` Channel; Agents without one remain unreachable through the dispatcher.

```bash [Terminal]
curl -X POST http://127.0.0.1:8787/api/_vitehub/agents/support/chat \
  -H 'content-type: application/json' \
  -d '{"id":"local","messages":[{"id":"user-1","role":"user","parts":[{"type":"text","text":"ping"}]}]}'
```

## Production notes

Deno Deploy uses `.output/server/index.mjs` as the generated server entrypoint.
Do not import generated files from application code to work around deployment configuration; keep application code on Agent Definitions, Runtime Helpers, and stable ViteHub imports.

Use Deno environment variables for model keys and other Runtime Env.
If you use Deno KV, verify the deployed runtime can call `Deno.openKv()` and choose an explicit KV Store when local development must not share production state.

## Next steps

- Use [Runtime and host support](/docs/frameworks-hosts/support-matrix) for the qualified host boundary.
- Use [Provider output](/docs/reference/provider-output) for generated artifact boundaries.
- Use [Generated files](/docs/development/generated-files) to inspect `.vitehub/**`.
- Use [Config options](/docs/reference/config-options) for Agent `runtime` and KV `driver` placement.
