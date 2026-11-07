---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and how the repository proves them.
navigation.title: Support matrix
navigation.order: 41
navigation.group: Choose a target
icon: i-lucide-table-properties
---

Check this page before you claim a feature works on a host. Rows are server
primitives or deployment contracts, and columns are hosts. Hover a cell to see
the host's provider and its limits. Select a proof cell to open its CI run.
`Package-specific` means the named package or generated output gives the
support, not the whole host.

::support-matrix
## Server primitives

| Primitive  | Local Vite       | Cloudflare            | Vercel                | Netlify              | Deno           | Nitro and UnJS | Node and self-hosted  |
| ---------- | ---------------- | --------------------- | --------------------- | -------------------- | -------------- | -------------- | --------------------- |
| Browser    | Local provider   | Browser Run           | —                     | —                    | —                    | —              | Local provider        |
| Blob       | `fs`             | R2                    | Vercel Blob           | Netlify Blobs        | S3-compatible  | Host driver    | `fs` or S3-compatible |
| Database   | SQLite           | D1                    | libSQL or D1 HTTP     | libSQL               | libSQL         | Nuxt D1        | SQLite or libSQL      |
| Email      | Resend           | Cloudflare Email      | Resend                | Resend               | Resend         | Host driver    | Resend or custom      |
| KV         | `fs-lite`        | Workers KV            | Upstash Redis         | Upstash Redis        | Deno KV        | Host driver    | `fs-lite` or Upstash  |
| Queue      | Local provider   | Cloudflare Queues     | Vercel Queues         | Cloudflare or Vercel | —              | Cloudflare or Vercel | Local provider        |
| Rate Limit | `memory`         | Rate Limiting binding | —                     | —                    | —              | Cloudflare     | `memory`              |
| Realtime   | `memory`         | Durable Objects       | —                     | —                    | —              | Host authority | `memory`              |
| Sandbox    | Sandbox provider     | Cloudflare Sandbox    | Vercel Sandbox        | Vercel Sandbox       | —              | Cloudflare or Vercel | Sandbox provider          |
| Schedule   | Local or process | Cron triggers         | Vercel Cron Jobs      | Scheduled functions  | Standalone `Deno.cron` | Provider Wake  | Process runtime       |
| Workflow   | OpenWorkflow     | Cloudflare Workflows  | Vercel Workflow       | OpenWorkflow         | OpenWorkflow   | Host provider  | OpenWorkflow          |
| Workspace  | Local or memory  | Artifacts or GitHub   | Vercel Blob or GitHub | GitHub               | GitHub         | Host store     | Local or GitHub       |

## Deployment and proof

| Contract                  | Local Vite          | Cloudflare           | Vercel               | Netlify                      | Deno                         | Nitro and UnJS               | Node and self-hosted         |
| ------------------------- | ------------------- | -------------------- | -------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Runtime helpers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Package-specific**         |
| Local providers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Not provided**             | **Local-only**               |
| Provision support         | **Not provided**    | **Package-specific** | **Package-specific** | **Not provided**             | **Not provided**             | **Not provided**             | **Not provided**             |
| Generated Provider Output | — | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | — |
| Contract tests | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) |
| Local Provider Run | — | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/32939970902) (last observed 2026-08-26; stale after 30 days) | **Not published** | **Not published** | **Not published** |
| Live Smoke | — | [Evidence](https://github.com/vite-hub/vitehub/actions/runs/41190104698) (last observed 2026-10-31; stale after 2 days) | **Failed** [Evidence](https://github.com/vite-hub/vitehub/actions/runs/41190104698) (last observed 2026-10-31; stale after 2 days) | **Not published** | **Not published** | **Not published** | **Not published** |
::

## Provider notes

The table names built-in providers or adapters.

- **Browser:** Browser Definitions require the Cloudflare preset. Local Wrangler can reach Browser Run in remote mode. Trusted local and self-hosted Node processes can call `createBrowser({ provider: localBrowser({ executablePath }) })`, but Browser Definitions do not select that provider.
- **Email:** `email: true` selects Cloudflare Email only on the Cloudflare preset; every other host requires the explicit built-in Resend driver or a programmatic custom driver.
- **Realtime:** Production uses Cloudflare Durable Objects, or memory that you select on a single-process Node server; distributed Vercel, Netlify, and Deno presets reject memory.
- A remote provider under Netlify, Deno, Nitro, or Node is an explicit package choice, not detected from the host. Local filesystem and memory options stay single-process development providers.

Local Vite delivers Queue Jobs in the dev server with the local provider, for every Queue Provider. It follows the build provider's retry, delay, and size rules, and `vitehub queue jobs list` shows the jobs. The build still generates the hosted provider output. Netlify requires an explicit Cloudflare or Vercel Queue Provider, because it cannot detect one. Netlify can use an explicit Vercel Sandbox provider with Vercel credentials; the Cloudflare Sandbox provider requires a Cloudflare binding and cannot run on Netlify.

## Proof scope

Cloudflare's nightly run covers nine primitives, Rate Limit included. Vercel covers eight, because ViteHub has no Vercel Rate Limit driver. Browser and Agent routes have contract tests but are not in those deployed runs.

## Qualifications

- **Local Vite:** Active integrations expose their imports and generated registries. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` give local state. A local build can still generate output for an explicit or detected hosted provider.
- **Cloudflare:** Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Browser and Agent have package output outside the nightly run. Integrations build the Worker, `wrangler.json`, bindings, callbacks, and runtime modules. ViteHub can provision R2 buckets, D1 databases, KV namespaces, and Cloudflare Queues.
- **Vercel:** Blob, Database, KV, Queue, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Agent routes have package output outside the nightly run. Integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules. ViteHub can create a Blob store and set the project environment.
- **Netlify:** Blob uses `netlify-blobs`. Agent HTTP routes and static Schedules write functions under `.netlify/v1/functions`. CI runs the real-project fixture through Netlify CLI. There is no Netlify provisioning or published live proof.
- **Deno:** Agent chat and webhook routes and KV with `deno-kv` work with their documented permissions. A production build stages the Nitro application and package-owned standalone Schedule output under `.output`. Add Schedule with `hubSchedule({ providerOutput: "standalone" })`; `vitehub({ preset: "deno", schedule: true })` rejects Schedule because `vitehub()` does not own that output. There is no published live Deno proof.
- **Nitro and UnJS:** Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring belong to their packages. Nitro is glue, not a storage or execution provider. There is no Nitro provisioning or unified live matrix.
- **Node and self-hosted:** Server APIs and handlers run when their driver supports Node. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` are single-process providers. ViteHub does not emit one Node deployment bundle, provision a self-hosted plan, or publish a live suite.

Local memory and filesystem providers stay single-process after deployment. Generated files belong to their packages. Do not import them in app code.
