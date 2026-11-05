---
title: Queue hosts
description: Run Queue jobs in the dev server, check discovery, and inspect the Nitro output for Cloudflare and Vercel.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Develop locally

`pnpm dev` runs Queue jobs in the dev server for every preset. `runQueue()` stores the job in `.vitehub/data/queue`, and the dev server runs the Queue Definition. A Cloudflare or Vercel app needs no binding or credentials. The dev server follows the retry, delay, and size rules of the provider of the build, so a handler fails and retries as it does on the host. [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) lists the rules and what dev does not emulate.

```bash [Terminal]
pnpm vitehub queue list
pnpm vitehub queue jobs list
pnpm vitehub queue jobs show <message-id>
pnpm vitehub queue jobs retry <message-id>
pnpm vitehub queue jobs clear --state dead --yes
```

`queue list` shows `provider: "local"`, the job directory, `durability: "single-host"`, `deadLimit` (the dead jobs kept per Queue Definition), and the pending, running, and dead jobs of each Queue Definition. In a Cloudflare or Vercel app it also shows `rules`, the provider of the build. `queue jobs list` shows each stored job with its attempts and last error. `queue jobs show` adds the payload. `queue jobs retry` runs a job now, and a dead job gets a new set of attempts. `queue jobs clear` removes pending and dead jobs. It asks for confirmation on a terminal and needs `--yes` elsewhere. Each command takes `--json`, and `--url` for a deployed app. The Console and agents run the same `queue.jobs-*` operations.

With `preset: 'node'`, the built server uses the local provider too. This also works in Docker and in a StackBlitz WebContainer. The jobs survive a restart on the same disk. In Docker, mount `.vitehub/data` as a volume, or a new container starts without them. Run one server process per directory. [Local delivery](/docs/queue/limits-and-errors#local-delivery) lists the retry and dead-job rules.

For Cloudflare or Vercel, use a build to check that ViteHub generates the right Nitro output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

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

For fast unit coverage, test the code that your handler calls. `pnpm dev` proves Queue Enqueue and Queue Delivery together with the rules of the provider. To prove the provider itself, use the built Worker with `wrangler dev`, or a deployed app.

## Host output

Nitro is the only host output. The Queue Package discovers Queue Definitions, generates a Runtime Registry, and adds Queue Delivery to the Nitro config.

| Provider | Output |
| --- | --- |
| Cloudflare | `wrangler.json` queue producer and consumer entries. Nitro's `cloudflare:queue` hook runs the consumer. |
| Vercel | One Nitro route per Queue Definition under `/api/vitehub/queues/vercel/`. `vercel.functionRules` gives each route its queue trigger, so Nitro writes one function per Queue Definition. |
| Local | The Queue Nitro plugin. It reads `.vitehub/data/queue` when the server starts and runs the due jobs. `pnpm dev` uses it for every provider, and the build keeps the provider output above. |

Do not import generated files from application code.
