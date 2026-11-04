---
title: Queue hosts
description: Check Queue discovery locally and inspect the Nitro output for Cloudflare and Vercel.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Develop locally

With `preset: 'node'`, Queue uses the local provider in `pnpm dev` and in the built server. `runQueue()` stores the job in `.vitehub/data/queue`, and the server process runs the Queue Definition. This also works in Docker and in a StackBlitz WebContainer. The server logs the directory and the durability once when it starts:

```bash [Terminal]
pnpm vitehub queue list
```

The list shows `provider: "local"`, the job directory, `durability: "single-host"`, and the pending, running, and dead jobs of each Queue Definition. The jobs survive a restart on the same disk. In Docker, mount `.vitehub/data` as a volume, or a new container starts without them. Run one server process per directory. [Local delivery](/docs/queue/limits-and-errors#local-delivery) lists the retry and dead-job rules.

For Cloudflare or Vercel, use a build to check that ViteHub discovers your Queue Definitions and generates the right Nitro output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

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
| Local | The Queue Nitro plugin. It reads `.vitehub/data/queue` when the server starts and runs the due jobs. |

Do not import generated files from application code.
