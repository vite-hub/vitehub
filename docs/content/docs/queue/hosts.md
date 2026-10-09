---
title: Queue hosts
description: Check Queue discovery locally and inspect the Provider Output for Cloudflare and Vercel.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Develop locally

Queue has no in-memory Queue Provider for local delivery. Use a build to check that ViteHub discovers your Queue Definitions and generates the right provider output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

```bash [Terminal]
pnpm add vite-hub
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```

The build writes `.vitehub/queue/registry.mjs`. `vitehub inspect definitions` lists the Queue Definitions that ViteHub found. Then inspect the Provider Output for the Queue Provider you configured.

| Provider | Output to inspect |
| --- | --- |
| Cloudflare | `dist/**/wrangler.json` queue producers and consumers, plus the generated worker bundle. |
| Vercel | `.vercel/output/functions/api/vitehub/queues/vercel/**` consumer functions and trigger config. |

Vercel projects that typecheck generated Queue Provider Output need `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

For fast unit coverage, test the code that your handler calls. To prove Queue Enqueue and Queue Delivery together, use the generated provider runtime or deployed provider output.

## Provider output

The Queue Package discovers Queue Definitions, generates a Runtime Registry, and emits provider-specific Queue Delivery output.

| Provider | Output |
| --- | --- |
| Cloudflare | Worker bundle plus `wrangler.json` queue producer and consumer entries. |
| Vercel | Queue consumer functions under `.vercel/output/functions/api/vitehub/queues/vercel/**` and queue trigger config. |

Generated files are Provider Output. Do not import them from application code.
