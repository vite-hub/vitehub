---
title: Queue hosts
description: Check Queue discovery locally and inspect the Nitro output for Cloudflare and Vercel.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Develop locally

Queue has no in-memory Queue Provider for local delivery. Use a build to check that ViteHub discovers your Queue Definitions and generates the right Nitro output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

```bash [Terminal]
pnpm add vite-hub
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```

The build writes `.vitehub/queue/registry.mjs`. `vitehub inspect definitions` lists the Queue Definitions that ViteHub found. Then inspect the Nitro output for the Queue Provider you configured.

| Provider | Output to inspect |
| --- | --- |
| Cloudflare | `.output/server/wrangler.json` queue producers and consumers. |
| Vercel | `.vercel/output/functions/api/vitehub/queues/vercel/<name>.func/.vc-config.json` queue triggers. |

Vercel projects that typecheck generated Queue files need `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

For fast unit coverage, test the code that your handler calls. To prove Queue Enqueue and Queue Delivery together, use the Nitro build or a deployed app.

## Host output

Nitro is the only host output. The Queue Package discovers Queue Definitions, generates a Runtime Registry, and adds Queue Delivery to the Nitro config.

| Provider | Output |
| --- | --- |
| Cloudflare | `wrangler.json` queue producer and consumer entries. Nitro's `cloudflare:queue` hook runs the consumer. |
| Vercel | One Nitro route per Queue Definition under `/api/vitehub/queues/vercel/`. `vercel.functionRules` gives each route its queue trigger, so Nitro writes one function per Queue Definition. |

Do not import generated files from application code.
