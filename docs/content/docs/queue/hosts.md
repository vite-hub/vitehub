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

With `preset: 'node'` and no Postgres Database, the built server uses the local provider too. This also works in Docker and in a StackBlitz WebContainer. The jobs survive a restart on the same disk. In Docker, mount `.vitehub/data` as a volume, or a new container starts without them. Run one server process per directory. [Local delivery](/docs/queue/limits-and-errors#local-delivery) lists the retry and dead-job rules.

## Run on several Node instances

With `preset: 'node'` and a Postgres Default Database, the build uses the postgres provider. Each server process uses the connection of the Default Database, and takes due jobs from the `vitehub_queue_jobs` table. `QUEUE_POSTGRES_URL` on the server overrides the connection. All instances share the jobs, so a job that instance A accepts can run on instance B. `pnpm dev` keeps the jobs in `.vitehub/data/queue` with the same retry rules, so development needs no Postgres. [Postgres delivery](/docs/queue/limits-and-errors#postgres-delivery) lists the rules.

`vitehub queue list` shows `provider: "postgres"`, the table and its database without the password, and `durability: "shared"`. The `queue jobs` commands and the Console read and change the jobs in Postgres, so any instance shows the jobs of all instances.

For Cloudflare or Vercel, use a build to check that ViteHub generates the right Nitro output. A standalone Node process, such as a `tsx` script, does not run Vite discovery or load the generated Queue Runtime Registry, so `runQueue()` cannot find queue files from there.

```bash [Terminal]
pnpm add vite-hub @vite-hub/queue
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
| Postgres | The Queue Nitro plugin. It creates the jobs table when the server starts, takes due jobs, and drains the running jobs when Nitro closes. |

Do not import generated files from application code.

## Preview deployments

A Cloudflare Version URL runs with the production resources of its Worker version, so it sends to production queues ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/)). Two Cloudflare Previews that bind the same queue name send to the same queue ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)). For a Cloudflare Preview, declare preview queue producers in `previews.queues.producers` of the project Wrangler config, because ViteHub does not write that block. Cloudflare does not accept Queue consumers there ([Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/)). For a preview Worker of its own, set `queue.namePrefix` in its build. Read [Preview deployments share data](/docs/development/provisioning#preview-deployments-share-data).
