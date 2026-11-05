---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and how the repository proves them.
navigation.title: Support matrix
navigation.order: 41
navigation.group: Choose a target
icon: i-lucide-table-properties
---

Use this page before you claim that a feature works on a host. Each row is a
server primitive, an app feature, or a deployment contract, and each column is a
host. Hover over a cell to see the provider that the host uses and the limits of
that support. Select a proof cell to open the CI run behind it.
`Package-specific` means that the app must select the provider explicitly, or
that support belongs to the named package or generated output, not the host as
a whole.

The primitive and feature rows come from the ViteHub feature catalog in
`@vite-hub/internal/features`. A cell says what `vitehub({...})` does when the
app enables the feature for that preset. The Local Vite column is `vite dev`
with local providers. The Nitro and UnJS column describes generic Nitro output.

::support-matrix
## Server primitives

<!-- support-matrix:server-primitives:start -->
| Primitive | Local Vite | Cloudflare | Vercel | Netlify | Deno | Nitro and UnJS | Node and self-hosted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browser | — | Browser Run | — | — | — | — | — |
| Blob | fs | R2 | Vercel Blob | Netlify Blobs | S3 | Host driver | fs / S3 |
| Cache | fs-lite | Workers KV | Runtime Cache | KV | Deno KV | Host driver | fs-lite |
| Database | SQLite | D1 | libSQL / D1 | libSQL | libSQL | Nuxt D1 | SQLite / libSQL |
| Email | Resend | Cloudflare Email | Resend | Resend | Resend | Host driver | Resend / custom |
| KV | fs-lite | Workers KV | Upstash | Upstash | Deno KV | Host driver | fs-lite / Upstash |
| Queue | Local provider | Queues | Vercel Queues | — | — | Cloudflare / Vercel | Local provider |
| Rate Limit | memory | Cloudflare | — | — | — | Cloudflare | memory |
| Realtime | memory | Durable Objects | — | — | — | Host authority | memory |
| Sandbox | Sandbox provider | CF Sandbox | Vercel Sandbox | — | — | Cloudflare / Vercel | — |
| Schedule | Local / process | Cron triggers | Vercel Cron | Scheduled fn | — | Provider Wake | process |
| Workflow | Vercel Workflow | CF Workflows | Vercel Workflow | OpenWorkflow | Vercel Workflow | Host provider | Vercel Workflow |
| Workspace | local / memory | Artifacts / GitHub | memory / Blob / GitHub | GitHub | GitHub | Host store | local / GitHub |
<!-- support-matrix:server-primitives:end -->

## Agents and app features

<!-- support-matrix:application-features:start -->
| Feature | Local Vite | Cloudflare | Vercel | Netlify | Deno | Nitro and UnJS | Node and self-hosted |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Agent | Nitro | Nitro | Nitro | Nitro | Nitro | Agent routes | Nitro |
| Auth | Better Auth | Better Auth | Better Auth | Better Auth | Better Auth | Auth route | Better Auth |
| Channels | Nitro | Nitro | Nitro | Nitro | Nitro | Agent routes | Nitro |
| Comments | Database | Database | Database | Database | Database | Host database | Database |
| Connections | Database | Database | Database | Database | Database | Host database | Database |
| Console | Nitro | Nitro | Nitro | Nitro | Nitro | Nitro routes | Nitro |
| Env | Nitro | Nitro | Nitro | Nitro | Nitro | Nitro runtime | Nitro |
| Logs | Nitro | Nitro | Nitro | Nitro | Nitro | Host source | Nitro |
| Observability | Evlog | Evlog | Evlog | Evlog | Evlog | Evlog | Evlog |
<!-- support-matrix:application-features:end -->

## Deployment and proof

| Contract                  | Local Vite          | Cloudflare           | Vercel               | Netlify                      | Deno                         | Nitro and UnJS               | Node and self-hosted         |
| ------------------------- | ------------------- | -------------------- | -------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Runtime helpers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Package-specific**         |
| Local providers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Not provided**             | **Local-only**               |
| Provision support         | **Not provided**    | **Package-specific** | **Package-specific** | **Not provided**             | **Not provided**             | **Not provided**             | **Not provided**             |
| Generated Provider Output | — | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | — |
| Contract tests | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) |
| Local Provider Run | — | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | **Not published** | **Not published** | **Not published** |
| Live Smoke | — | **Stopped at provision** [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32928943031) (last observed 2026-08-26; stale after 2 days) | **Stopped at provision** [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32928943031) (last observed 2026-08-26; stale after 2 days) | **Not published** | **Not published** | **Not published** | **Not published** |
::

## Provider notes

Names in this table are concrete built-in providers or adapters. Browser Definitions currently require the Cloudflare preset; local Wrangler can connect to Browser Run with remote mode. Trusted local and self-hosted Node processes can call `createBrowser({ provider: localBrowser({ executablePath }) })`, but Browser Definitions do not select that provider. Email's boolean default selects Cloudflare Email only on the Cloudflare preset; every other host requires the explicit built-in Resend driver or a programmatic custom driver. Realtime production uses Cloudflare Durable Objects or explicitly selected memory on a single-process Node server; distributed Vercel, Netlify, and Deno presets reject memory. A remote provider shown under Netlify, Deno, Nitro, or Node is an explicit package choice, not host inference. Local filesystem and memory options remain single-process development providers.

Local Vite delivers Queue Jobs through the local provider, which stores jobs in `.vitehub/data/queue` and runs them in the dev server process. `vitehub({ queue: true })` fails on Netlify because `queue` has no provider option. Compose `hubQueue({ provider })` to select the Cloudflare or Vercel Queue Provider there. `vitehub({ sandboxTask: true })` fails on the Netlify and Node presets. Compose `hubSandboxTask({ provider: 'vercel' })` to use Vercel Sandbox with Vercel credentials. Do not use Cloudflare Sandbox there: the Cloudflare Sandbox provider requires a Cloudflare binding and cannot run on Netlify.

Workspace on Cloudflare uses the memory store by default, so its state stays in one Worker isolate. Select the Cloudflare Artifacts or GitHub Workspace Store for durable state. Workspace on Vercel also defaults to process-local memory; a non-empty `BLOB_READ_WRITE_TOKEN` selects Vercel Blob, or the app can select GitHub explicitly. Realtime on Node needs `realtime: { authority: "memory" }` for a build, and that authority is safe only for a single-process server.

Workflow defaults to Vercel Workflow on Local Vite, Node, and Deno. Node hosting selects OpenWorkflow when `workflow.sqlite.path` or `workflow.postgres.url` is configured, unless `workflow.provider` is explicit. Netlify requires an explicit `workflow.provider`.

## Proof scope

Cloudflare's nightly target includes nine primitives, including Rate Limit. Vercel targets eight because ViteHub has no native Vercel Rate Limit driver. Browser and Agent routes have contract tests but are outside those deployed runs.

## Qualifications

- **Local Vite:** Active integrations expose their package imports and generated registries. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` provide local state. A local build can still generate output for an explicit or inferred hosted provider.
- **Cloudflare:** Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Browser and Agent have package-owned output outside the nightly run. Enabled integrations compose the Worker, `wrangler.json`, bindings, callbacks, and runtime modules. ViteHub can provision R2 buckets, D1 databases, KV namespaces, and Cloudflare Queues.
- **Vercel:** Blob, Database, KV, Queue, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Agent routes have separate package output outside the nightly run. Enabled integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules. ViteHub can create a Blob store and configure the project environment.
- **Netlify:** Blob uses `netlify-blobs`. Agent HTTP routes and static Schedules write functions under `.netlify/v1/functions`. CI runs the real-project fixture through Netlify CLI. ViteHub does not provide Netlify provisioning or published live proof.
- **Deno:** Agent chat and webhook routes and KV with `deno-kv` are supported with their documented permissions. A production build stages the Nitro application and package-owned standalone Schedule output under `.output`. Compose Schedule with `hubSchedule({ providerOutput: "standalone" })`; `vitehub({ preset: "deno", schedule: true })` rejects Schedule because the facade does not own that output. ViteHub does not publish live Deno proof.
- **Nitro and UnJS:** Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring are package-owned integrations. Nitro is integration glue rather than a storage or execution provider. ViteHub does not provide Nitro provisioning or one unified live matrix.
- **Node and self-hosted:** Server APIs and handlers run when their selected driver supports Node. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` are single-process providers. ViteHub does not emit one Node deployment bundle, provision a self-hosted plan, or publish one live suite.

Local memory and filesystem providers stay single-process after deployment. Generated files remain package-owned and must not be imported by application code.
