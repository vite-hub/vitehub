---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and whether CI tests them live, locally, or not at all.
navigation.title: Support matrix
navigation.order: 41
navigation.group: Choose a target
icon: i-lucide-table-properties
---

Use this page before you claim that a feature works on a host. Each row is a
server primitive, an app feature, or a deployment contract, and each column is a
host. Hover over a cell to see the provider that the host uses and the limits of
that support. [Test status](#test-status) says what CI checks on each host.
`Package-specific` means that the app must select the provider explicitly, or
that support belongs to the named package or generated output, not the host as
a whole.

The primitive and feature rows come from the ViteHub feature catalog in
`@vite-hub/internal/features`. A cell says what `vitehub({...})` does when the
app enables the feature for that host, including requirements from features it
enables implicitly. Comments and Connections require a hosted
`database.connection` on Vercel, Netlify, and Deno. The Local Vite column is
`vite dev` with the default Node host; development with a different host can
select different providers. The Nitro and UnJS column describes generic Nitro output.

::support-matrix
## Server primitives

<!-- support-matrix:server-primitives:start -->
| Primitive | Local Vite | Cloudflare | Vercel | Netlify | Deno | Nitro and UnJS | Node and self-hosted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser | — | Browser Run | — | — | — | — | — |
| Blob | fs | R2 | Vercel Blob | Netlify Blobs | S3 | Host driver | fs / S3 |
| Cache | fs-lite | Workers KV | Runtime Cache | KV | Deno KV | Host driver | fs-lite |
| Database | SQLite | D1 | libSQL / D1 / Postgres | libSQL / D1 / Postgres | libSQL / D1 / Postgres | Nuxt D1 | SQLite / libSQL / Postgres |
| Email | Resend | Cloudflare Email | Resend | Resend | Resend | Host driver | Resend / custom |
| KV | fs-lite | Workers KV | Upstash | Upstash / Redis | Deno KV | Host driver | Redis / Postgres / fs-lite |
| Queue | Local driver | Queues | Vercel Queues | — | — | Cloudflare / Vercel | Postgres / local driver |
| Rate Limit | memory | Cloudflare | — | — | — | Cloudflare | memory, or KV |
| Realtime | memory | Durable Objects | — | — | — | Host driver | Postgres or Redis |
| Sandbox | — | CF Sandbox | Vercel Sandbox | Vercel Sandbox | — | Cloudflare / Vercel | Vercel Sandbox |
| Schedule | Local / process | Cron triggers | Vercel Cron | Scheduled fn | Deno.cron | Provider Wake | process |
| Workflow | OpenWorkflow | CF Workflows | Vercel Workflow | OpenWorkflow | OpenWorkflow | Host provider | OpenWorkflow |
| Workspace | local / memory | Artifacts / GitHub | memory / Blob / GitHub | GitHub | GitHub | Host store | local / GitHub |
<!-- support-matrix:server-primitives:end -->

## Agents and app features

<!-- support-matrix:application-features:start -->
| Feature | Local Vite | Cloudflare | Vercel | Netlify | Deno | Nitro and UnJS | Node and self-hosted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent | Nitro | Nitro | Nitro | Nitro | Nitro + OpenWorkflow | Agent routes | Nitro |
| Auth | Better Auth | Better Auth | Better Auth | Better Auth | Better Auth | Auth route | Better Auth |
| Channels | Nitro | Nitro | Nitro | Nitro | Nitro | Agent routes | Nitro |
| Comments | Database | Database | Database + libSQL / D1 / Postgres | Database + libSQL / D1 / Postgres | Database + libSQL / D1 / Postgres | Host database | Database |
| Connections | Database | Database | Database + libSQL / D1 / Postgres | Database + libSQL / D1 / Postgres | Database + libSQL / D1 / Postgres | Host database | Database |
| Console | Nitro | Nitro | Nitro | Nitro | Nitro | Nitro routes | Nitro |
| Env | Nitro | Nitro | Nitro | Nitro | Nitro | Nitro runtime | Nitro |
| I18n | Nitro 3 | Nitro 3 | Nitro 3 | Nitro 3 | Nitro 3 | Nitro 3 | Nitro 3 |
| MCP server | Nitro | Nitro | Nitro | Nitro | Nitro | Nitro route | Nitro |
| Observability | Evlog | Evlog | Evlog | Evlog | Evlog | Evlog | Evlog |
<!-- support-matrix:application-features:end -->

## Deployment

| Contract                  | Local Vite          | Cloudflare           | Vercel               | Netlify                      | Deno                         | Nitro and UnJS               | Node and self-hosted         |
| ------------------------- | ------------------- | -------------------- | -------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Runtime helpers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Package-specific**         |
| Local providers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Not provided**             | **Local-only**               |
| Provision support         | **Not provided**    | **Package-specific** | **Package-specific** | **Not provided**             | **Not provided**             | **Not provided**             | **Not provided**             |
::

## Provider notes

The table names built-in providers or adapters.

- **Browser:** Browser Definitions require the Cloudflare host. Local Wrangler can reach Browser Run in remote mode. Trusted local and self-hosted Node processes can call `createBrowser({ driver: localBrowser({ executablePath }) })`, but Browser Definitions do not select that driver.
- **Email:** `email: true` selects Cloudflare Email only on the Cloudflare host; every other host requires the explicit built-in Resend driver or a programmatic custom driver.
- **Realtime:** Production uses Cloudflare Durable Objects on Cloudflare. On Node, `auto` picks Redis with `REDIS_URL`, else Postgres with `REALTIME_POSTGRES_URL` or a Postgres Default Database, else memory in one process. Vercel, Netlify, and Deno builds with Realtime fail.

Local Vite delivers Queue Jobs in the dev server through the local driver, which stores jobs in `.vitehub/data/queue`. For every Queue driver, development follows the retry, delay, and size rules of the driver of the build, and `vitehub queue jobs list` shows the jobs. The build still generates the hosted driver output. `vitehub({ queue: true })` fails on Netlify because `queue` has no driver option. Compose `hubQueue({ driver })` to select the Cloudflare or Vercel Queue driver there. `vitehub({ sandboxTask: true })` fails on the Netlify and Node hosts. Set `sandboxTask: { driver: 'vercel' }` to use Vercel Sandbox with Vercel credentials. Cloudflare Sandbox works only on the Cloudflare host, because it needs a Cloudflare binding.

Workspace on Cloudflare uses the memory store by default, so its state stays in one Worker isolate. Select the Cloudflare Artifacts or GitHub Workspace Store for durable state. Workspace on Vercel also defaults to process-local memory; a non-empty `BLOB_READ_WRITE_TOKEN` selects Vercel Blob, or the app can select GitHub explicitly. Realtime on Node shares rooms across instances with Redis or Postgres. With `memory`, rooms stay in one process.

Workflow defaults to OpenWorkflow on Node and in Local Vite with the `node` preset, and each server runs the OpenWorkflow worker. It uses `OPENWORKFLOW_POSTGRES_URL`, then the app's Postgres Default Database, else a SQLite file on one host. Local Vite uses the SQLite file unless `workflow.remote` is `true`. On Node, Agent turns are OpenWorkflow runs: any server's worker executes them, and a queued turn runs after a restart. Deno builds require a driver or OpenWorkflow storage; development and Agent-only Workflows can run inline. Netlify requires an explicit `workflow.driver`. An explicit `workflow.driver` always wins.

## Test status

Each host has a test status. The status tells what CI checks. It does not tell whether the latest run passed: the [live smoke runs](https://github.com/vite-hub/vitehub/actions/workflows/live-smoke.yml) and the CI runs show that.

- **Live tested:** a nightly CI job deploys the shared playground to the real host and calls the primitive.
- **Tested locally:** CI calls the primitive on a local runtime of the host, such as Wrangler, a Vercel function bridge, or Node. No CI job calls it on the real host.
- **Experimental:** ViteHub has a provider or output for the host, but no CI run calls the primitive there. Unit tests, mocks, or build-output checks can exist.

| Host | Status | What CI checks |
| --- | --- | --- |
| Cloudflare | Live tested | The live smoke calls the nine primitives in the next table. CI on `main` runs the same checks, except Sandbox, on Wrangler. |
| Vercel | Live tested | The live smoke calls the eight primitives in the next table. CI on `main` runs Database, KV, Schedule, and Workflow on a local function bridge with local Redis and libSQL. |
| Netlify | Experimental | CI on `main` builds one Agent app and sends one chat request to it through Netlify CLI. No CI run calls a primitive on Netlify. |
| Deno | Experimental | CI builds one app and starts its Deno server. No CI run calls a primitive on Deno. |
| Node and self-hosted | Tested locally | Package tests run Node providers, such as Blob `fs`, KV `fs-lite`, the local Queue, and Rate Limit `memory`. Service tests run Database, KV, and Schedule with real Postgres and Redis. No CI job deploys a Node server. |

Local Vite and Nitro and UnJS have no test status. Local Vite is the dev server, and Nitro is integration glue.

On Cloudflare and Vercel, the status changes per primitive. A dash means that the host has no provider for the primitive.

<!-- support-matrix:test-status:start -->
| Primitive | Cloudflare | Vercel |
| --- | --- | --- |
| Browser | Experimental | — |
| Blob | Live tested | Live tested |
| Cache | Experimental | Experimental |
| Database | Live tested | Live tested |
| Email | Experimental | Experimental |
| KV | Live tested | Live tested |
| Queue | Live tested | Live tested |
| Rate Limit | Live tested | — |
| Realtime | Experimental | — |
| Sandbox | Live tested | Live tested |
| Schedule | Live tested | Live tested |
| Workflow | Live tested | Live tested |
| Workspace | Live tested | Live tested |
<!-- support-matrix:test-status:end -->

Agent routes are not in the live smoke on any host.

## Qualifications

- **Local Vite:** Active integrations expose their imports and generated registries. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` give local state. A local build can still generate output for an explicit or detected hosted provider.
- **Cloudflare:** Integrations build the Worker, `wrangler.json`, bindings, callbacks, and runtime modules. Browser and Agent add package-owned output. ViteHub can provision R2 buckets, D1 databases, KV namespaces, and Cloudflare Queues.
- **Vercel:** Integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules. Agent routes add package-owned output. ViteHub can create a Blob store and set the project environment.
- **Netlify:** Blob uses `netlify-blobs`. Agent HTTP routes and static Schedules write functions under `.netlify/v1/functions`. There is no Netlify provisioning or live test.
- **Deno:** Agent chat and webhook routes and KV with `deno-kv` need their documented permissions. A production build stages the Nitro application under `.output`. With `schedule: true`, it adds `Deno.cron` output and a `.output/main.ts` entrypoint that loads it before the server. There is no live Deno test.
- **Nitro and UnJS:** Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring belong to their packages. Nitro is glue, not a storage or execution provider. There is no Nitro provisioning or unified live matrix.
- **Node and self-hosted:** Server APIs and handlers run when their driver supports Node. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` are single-process providers. ViteHub does not emit one Node deployment bundle, provision a self-hosted plan, or publish a live suite.

Local memory and filesystem providers stay single-process after deployment. Generated files belong to their packages. Do not import them in app code.
