---
title: Queue hosts
description: Run Queue jobs in the dev server, check discovery, and inspect the Nitro output for Cloudflare and Vercel.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Develop locally

`pnpm dev` runs Queue jobs in the dev server for every host. `sendQueue()` stores the job in `.vitehub/data/queue`, and the dev server runs your queue file. Cloudflare and Vercel apps need no binding or credentials. Dev follows the retry, delay, and size rules of the build's provider, so a handler fails and retries as on the host. See [Dev delivery](/docs/queue/limits-and-errors#dev-delivery) for the rules and gaps.

```bash [Terminal]
pnpm vitehub queue list
pnpm vitehub queue jobs list
pnpm vitehub queue jobs show <message-id>
pnpm vitehub queue jobs retry <message-id>
pnpm vitehub queue jobs clear --state dead --yes
```

- `queue list` shows `provider: "local"`, the job folder, `durability: "single-host"`, `deadLimit` (dead jobs kept per queue), and the pending, running, and dead jobs of each queue. In a Cloudflare or Vercel app, also `rules`, the build's provider.
- `queue jobs list` shows each stored job with its attempts and last error. `queue jobs show` adds the payload.
- `queue jobs retry` runs a job now. A dead job gets new attempts.
- `queue jobs clear` removes pending and dead jobs. It asks to confirm on a terminal and needs `--yes` elsewhere.

Each command takes `--json`, and `--url` for a deployed app. The Console and agents run the same `queue.jobs-*` operations.

With `host: 'node'` and no Postgres Database, the built server also uses the local provider, in Docker and in a StackBlitz WebContainer too. Jobs survive a restart on the same disk. In Docker, mount `.vitehub/data` as a volume, or a new container loses them. Run one server process per folder. [Local delivery](/docs/queue/limits-and-errors#local-delivery) lists the retry and dead-job rules.

## Run on several Node instances

With `host: 'node'` and a Postgres Default Database, the build uses the postgres provider. Each server process uses the Default Database's connection and takes due jobs from the `vitehub_queue_jobs` table. `QUEUE_POSTGRES_URL` on the server overrides the connection. All instances share the jobs, so a job that instance A accepts can run on instance B. `pnpm dev` keeps jobs in `.vitehub/data/queue` with the same retry rules, so dev needs no Postgres. See [Postgres delivery](/docs/queue/limits-and-errors#postgres-delivery) for the rules.

`vitehub queue list` shows `provider: "postgres"`, the table and its database without the password, and `durability: "shared"`. The `queue jobs` commands and the Console read and change the jobs in Postgres, so any instance shows the jobs of all instances.

For Cloudflare or Vercel, build to check the Nitro output. A plain Node process, such as a `tsx` script, skips Vite discovery and the generated registry, so `sendQueue()` finds no queue files there.

```bash [Terminal]
pnpm add vite-hub @vite-hub/queue
pnpm vite build
pnpm vitehub inspect definitions --kind queue
```

The build writes `.vitehub/queue/registry.mjs`. `vitehub inspect definitions` lists the queues that ViteHub found. Then check the Nitro output of your provider.

| Provider | Output to inspect |
| --- | --- |
| Cloudflare | `.output/server/wrangler.json` queue producers and consumers. |
| Vercel | `.vercel/output/functions/api/vitehub/queues/vercel/<name>.func/.vc-config.json` queue triggers. |

To typecheck generated Queue files on Vercel, set `lib: ['DOM', 'ESNext']` and `types: ['node']` in `tsconfig.json`.

For fast unit tests, test the code your handler calls. `pnpm dev` tests sending and delivery together with the provider's rules. To test the provider itself, run the built Worker with `wrangler dev`, or deploy.

## Host output

Nitro is the only host output. The Queue package finds your queues, generates a registry, and adds delivery to the Nitro config.

| Provider | Output |
| --- | --- |
| Cloudflare | `wrangler.json` queue producers and consumers. Nitro's `cloudflare:queue` hook runs the consumer. |
| Vercel | One Nitro route per queue under `/api/vitehub/queues/vercel/`. `vercel.functionRules` gives each route its queue trigger, so Nitro writes one function per queue. |
| Local | The Queue Nitro plugin. It reads `.vitehub/data/queue` at server start and runs due jobs. `pnpm dev` uses it for every provider. The build keeps the output above. |
| Postgres | The Queue Nitro plugin. It creates the jobs table at server start, takes due jobs, and drains running jobs when Nitro closes. |

Do not import generated files in app code.

## Preview deployments

- A Cloudflare Version URL uses the production resources of its Worker version, so it sends to **production queues** ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/)).
- Two Cloudflare Previews that bind one queue name send to the same queue ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)).
- For a Preview, declare queue producers in `previews.queues.producers` of your Wrangler config. ViteHub does not write that block, and Cloudflare accepts no consumers there ([Previews configuration](https://developers.cloudflare.com/workers/previews/configuration/)).
- For a separate preview Worker, set `queue.namePrefix` in its build.

Read [Preview deployments share data](/docs/development/provisioning#preview-deployments-share-data).
