---
title: Vercel vs Netlify vs Cloudflare
description: Compare Vercel, Netlify, and Cloudflare for Vite apps and Agents by queues, cron, storage, sandboxes, run time, and pricing, with what ViteHub uses on each.
seo.title: Vercel vs Netlify vs Cloudflare for Vite apps and Agents
navigation.title: Compare hosts
navigation.order: 41.2
navigation.group: Choose a target
icon: i-lucide-columns-3
---

Cloudflare runs your server as a Worker. It has its own queue, cron, object
storage, KV, SQL database, Durable Objects, and sandbox products. Vercel runs
Node functions. It has queues, cron, blob storage, workflows, and sandboxes,
and it gets databases and KV from Marketplace providers. Netlify runs Node
functions. It has blob storage, scheduled functions, background functions, and
a managed Postgres database.

For a ViteHub app, the hosts differ in three ways: which features have a
default provider, how long work can run, and how the host bills. The
`cloudflare` preset rejects none of the ViteHub features. The `vercel` preset
rejects Rate Limit. The `netlify` preset rejects Queue, Rate Limit, and Sandbox
when you enable them with `true`.

Each table below has the host's service, a fact from the host's docs, and the
provider that ViteHub selects on that preset. The ViteHub column comes from the
[Cloudflare](/docs/frameworks-hosts/cloudflare),
[Vercel](/docs/frameworks-hosts/vercel), and
[Netlify](/docs/frameworks-hosts/netlify) pages and the
[support matrix](/docs/frameworks-hosts/support-matrix).

## Queues

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Vercel Queues](https://vercel.com/docs/queues) | Beta on all plans. At-least-once delivery with automatic retries. | Vercel Queues is the default Queue provider. |
| Netlify | [Async Workloads](https://docs.netlify.com/build/async-workloads/overview/) | An extension for event-driven work with retries and steps. | No Netlify Queue provider. `queue: true` fails the build. Select the Cloudflare or Vercel provider explicitly. |
| Cloudflare | [Cloudflare Queues](https://developers.cloudflare.com/queues/platform/pricing/) | On the Workers Free and Paid plans. Cloudflare bills each 64 KB that a queue writes, reads, or deletes. | Cloudflare Queues is the default Queue provider. |

Read [Queue hosts](/docs/queue/hosts) for the generated consumer output. The
[Vercel Queues](/docs/queue/vercel-queues) and
[Cloudflare Queues](/docs/queue/cloudflare-queues) guides show the setup on
each host.

## Cron

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Cron Jobs](https://vercel.com/docs/cron-jobs/usage-and-pricing) | All plans, 100 cron jobs for each project. Hobby runs at most once per day, at any minute of the hour you set. Pro and Enterprise run as often as once per minute. | Vercel Cron Jobs output for static Schedules. |
| Netlify | [Scheduled functions](https://docs.netlify.com/build/functions/scheduled-functions/) | All plans. 30-second run limit, UTC. They run only on published deploys. | One scheduled function for each static Schedule, with `hubSchedule({ providerOutput: 'standalone' })`. |
| Cloudflare | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) | UTC. A Cron Trigger can run for 15 minutes of wall-clock time. | Cron trigger output. |

ViteHub Schedule output needs a five-field UTC cron string. ViteHub does not
retry a failed run. Read [Schedule hosts](/docs/schedule/hosts) and the
[Vercel Cron Jobs](/docs/schedule/vercel-cron-jobs) guide.

## Blob storage

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Vercel Blob](https://vercel.com/docs/storage) | All plans. Public or private stores. | `vercel-blob` with `BLOB_READ_WRITE_TOKEN`. |
| Netlify | [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) | Eventually consistent by default. Changes reach all edge locations within 60 seconds. Strong consistency is opt-in. 5 GB per object. | `netlify-blobs`. No provisioning step. |
| Cloudflare | [R2](https://developers.cloudflare.com/r2/pricing/) | Cloudflare bills storage and operations. Egress is free. | An R2 bucket named after the app, with the `BLOB` binding. ViteHub can provision it. |

Read [Blob hosts](/docs/blob/hosts) and the [Vercel Blob](/docs/blob/vercel-blob)
guide.

## KV

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Marketplace storage](https://vercel.com/docs/storage) | Key-value stores come from providers such as Upstash. Vercel adds their credentials as environment variables. | Upstash Redis with `KV_REST_API_URL` and `KV_REST_API_TOKEN`. |
| Netlify | [Netlify Blobs](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) | Netlify Blobs can also work as a simple key/value store. | No Netlify KV provider. Set `KV_REST_API_URL` and `KV_REST_API_TOKEN` at build time to select Upstash Redis, or configure a remote driver explicitly. |
| Cloudflare | [Workers KV](https://developers.cloudflare.com/kv/concepts/how-kv-works/) | Eventually consistent. A change can take 60 seconds or more to show in other locations. | Workers KV with the `KV` binding. |

Read [KV hosts](/docs/kv/hosts).

## Database

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Marketplace storage](https://vercel.com/docs/storage) | Postgres and other databases from providers such as Neon and Supabase. | Hosted libSQL, such as Turso, Cloudflare D1 over HTTP, or Postgres with `connection.url`. |
| Netlify | [Netlify Database](https://docs.netlify.com/build/data-and-storage/netlify-db/) | Managed Postgres, on credit-based plans only. | Hosted libSQL, or Postgres with `connection.url`. |
| Cloudflare | [D1](https://developers.cloudflare.com/d1/platform/limits/) | 10 GB for each database on Workers Paid, 500 MB on Free. | A D1 binding from the Database Definition. Postgres can use a Hyperdrive binding. |

Read [Database hosts](/docs/database/hosts).

## Sandboxes

| Host | Host service | From the host docs | ViteHub on this preset |
| --- | --- | --- | --- |
| Vercel | [Vercel Sandbox](https://vercel.com/docs/sandbox) | Each sandbox runs in a Firecracker microVM. Vercel bills CPU only while code is active. | Vercel Sandbox is the default Sandbox provider. |
| Netlify | None that ViteHub uses | Not checked for this page | No Netlify Sandbox provider. `sandboxTask: true` fails the build. Vercel Sandbox works when you set Vercel credentials. |
| Cloudflare | [Sandbox SDK](https://developers.cloudflare.com/sandbox/) | Runs on Containers or Dynamic Workers. Needs the Workers Paid plan. Containers use a Durable Object scheduling policy that is in public beta. | Cloudflare Sandbox, with a generated Container and Durable Object binding. Local runs need `wrangler dev` and Docker. |

Read [Sandbox hosts](/docs/sandbox/hosts) and
[AI sandbox providers compared](/docs/sandbox/providers).

## Long-running work and Agents

| Host | Host limit | ViteHub Workflow default | ViteHub Agents |
| --- | --- | --- | --- |
| Vercel | [Functions](https://vercel.com/docs/functions/configuring-functions/duration) run for 300 seconds by default. The maximum is 300 seconds on Hobby and 800 seconds on Pro and Enterprise. Pro and Enterprise can set 1,800 seconds in beta. | Vercel Workflow | Agent routes in Vercel Build Output. Runs use Vercel Workflow by default. |
| Netlify | [Synchronous functions](https://docs.netlify.com/build/functions/configuration/) stop after 60 seconds, and you cannot change this. [Background functions](https://docs.netlify.com/build/functions/background-functions/) run for up to 15 minutes. | None. Set `workflow.provider` explicitly. | One `vitehub-agent` function. Agents run inline because `agent` alone does not enable Workflow on Netlify. |
| Cloudflare | [Workers](https://developers.cloudflare.com/workers/platform/limits/) get 10 ms of CPU time for each request on Free. On Paid, the default is 30 seconds and the maximum is 5 minutes. HTTP requests have no hard wall-clock limit while the client stays connected. | Cloudflare Workflows | Agent routes in the Worker. Runs use Cloudflare Workflows by default. Agent State uses a Durable Object. |

On Vercel and Netlify, Chat History that must survive a restart needs
`VITEHUB_AGENT_STATE_URL` or explicit Agent State options. Read
[Workflows hosts](/docs/workflows/hosts) for which Vercel entries survive a
function restart.

## Pricing model

| Host | How the host bills | Source |
| --- | --- | --- |
| Vercel | Hobby includes fixed amounts of usage. Pro gives a monthly usage credit, then bills on demand, and charges for each extra paid seat. Functions bill Active CPU, Provisioned Memory, and Invocations. | [Pricing on Vercel](https://vercel.com/docs/pricing) |
| Netlify | Credit-based plans: Free, Personal, Pro, and Enterprise. Production deploys, compute, bandwidth, and web requests use credits. | [Netlify pricing](https://www.netlify.com/pricing/) |
| Cloudflare | Workers bill requests and CPU time, not duration. The Paid plan starts at $5 per month for each account. KV, D1, R2, Queues, Durable Objects, Workflows, and Containers have their own prices. Durable Objects also bill duration. | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |

## Features that only Cloudflare provides in ViteHub

Of these three hosts, only Cloudflare has a ViteHub provider for these
features:

- Rate Limit uses the Cloudflare Rate Limiting binding. `rateLimit: true`
  fails the build on Vercel and Netlify.
- Realtime uses Durable Objects on Cloudflare. Vercel and Netlify reject the
  `memory` provider.
- Browser and `email: true` require the `cloudflare` preset. On other presets,
  Email needs the Resend driver or a custom driver.

ViteHub provisioning creates resources on Cloudflare and Vercel. It does not
create Netlify resources. Netlify Blobs needs no provisioning.

## Switch hosts with ViteHub

Route code imports `vite-hub/*` paths, so it does not change when the host
changes. To switch hosts:

1. Change `preset` in `vite.config.ts`, or in `nuxt.config.ts` for Nuxt.
2. Check each enabled feature against the
   [support matrix](/docs/frameworks-hosts/support-matrix). A feature that the
   new preset cannot provide fails the build.
3. Set the credentials and bindings that the new host page lists.
4. Run `pnpm build`, then `pnpm vitehub inspect provider-output` to list the
   generated host files.
5. On Cloudflare or Vercel, preview the resources with
   `pnpm vitehub provision run --provider cloudflare --dry-run`, or with
   `--provider vercel`. Read [Provisioning](/docs/development/provisioning).
6. Move existing data with the provider's own tools. A new preset writes new
   data to the new provider.

```diff [vite.config.ts]
 vitehub({
-  preset: 'vercel',
+  preset: 'cloudflare',
   blob: true,
   queue: true,
 })
```

Read [Prepare a production deployment](/docs/frameworks-hosts/production)
before you serve traffic on the new host.

::agent-only
Use this page when a user asks which host to choose for a ViteHub app, or compares Vercel, Netlify, and Cloudflare for Vite apps or Agents.

Base every ViteHub claim on the support matrix and the host pages, not on this summary. On the `netlify` preset, `queue: true`, `rateLimit: true`, and `sandboxTask: true` fail the build, and Workflow needs an explicit `workflow.provider`. On the `vercel` preset, `rateLimit: true` fails the build.

Vendor limits and prices change. Link the vendor source and give the date that you checked it.
::

Last checked: 2026-10-29.
