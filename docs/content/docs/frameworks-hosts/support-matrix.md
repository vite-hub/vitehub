---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and how the repository proves them.
navigation.title: Support matrix
navigation.order: 41
icon: i-lucide-table-properties
---

`Package-specific` means support belongs to the named package or generated output, not the host as a whole.

## Server primitives

| Primitive  | Local Vite       | Cloudflare            | Vercel                | Netlify              | Deno          | Nitro and UnJS | Node and self-hosted  |
| ---------- | ---------------- | --------------------- | --------------------- | -------------------- | ------------- | -------------- | --------------------- |
| Browser    | —                | Browser Run           | —                     | —                    | —             | —              | —                     |
| Blob       | `fs`             | R2                    | Vercel Blob           | Netlify Blobs        | S3-compatible | Host driver    | `fs` or S3-compatible |
| Database   | SQLite           | D1                    | libSQL or D1 HTTP     | libSQL               | libSQL        | Nuxt D1        | SQLite or libSQL      |
| KV         | `fs-lite`        | Workers KV            | Upstash Redis         | Upstash Redis        | Deno KV       | Host driver    | `fs-lite` or Upstash  |
| Queue      | Discovery only   | Cloudflare Queues     | Vercel Queues         | Cloudflare or Vercel | —             | Cloudflare     | —                     |
| Rate Limit | `memory`         | Rate Limiting binding | —                     | —                    | —             | Cloudflare     | `memory`              |
| Sandbox    | Box provider     | Cloudflare Sandbox    | Vercel Sandbox        | —                    | —             | Cloudflare     | Box provider          |
| Schedule   | Local or process | Cron triggers         | Vercel Cron Jobs      | Scheduled functions  | `Deno.cron`   | Provider Wake  | Process runtime       |
| Workflow   | OpenWorkflow     | Cloudflare Workflows  | Vercel Workflow       | OpenWorkflow         | OpenWorkflow  | Host provider  | OpenWorkflow          |
| Workspace  | Local or memory  | Artifacts or GitHub   | Vercel Blob or GitHub | GitHub               | GitHub        | Host store     | Local or GitHub       |

Names in this table are concrete built-in providers or adapters. Browser Definitions currently require the Cloudflare preset; local Wrangler can connect to Browser Run with remote mode. A remote provider shown under Netlify, Deno, Nitro, or Node is an explicit package choice, not host inference. Local filesystem and memory options remain single-process development providers.

Local Vite discovers Queue Definitions and generates provider output, but it does not deliver Queue Jobs. Netlify requires an explicit Cloudflare or Vercel Queue Provider because it cannot infer one.

## Deployment and proof

| Contract                  | Local Vite          | Cloudflare           | Vercel               | Netlify                      | Deno                         | Nitro and UnJS               | Node and self-hosted         |
| ------------------------- | ------------------- | -------------------- | -------------------- | ---------------------------- | ---------------------------- | ---------------------------- | ---------------------------- |
| Runtime helpers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Package-specific**         |
| Local providers           | **Available**       | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Not provided**             | **Local-only**               |
| Generated Provider Output | **Not provided**    | **Package-specific** | **Package-specific** | **Package-specific**         | **Package-specific**         | **Package-specific**         | **Not provided**             |
| Provision support         | **Not provided**    | **Package-specific** | **Package-specific** | **Not provided**             | **Not provided**             | **Not provided**             | **Not provided**             |
| Contract tests            | **Contract-tested** | **Contract-tested**  | **Contract-tested**  | **Contract-tested**          | **Contract-tested**          | **Contract-tested**          | **Contract-tested**          |
| Local Provider Run        | —                   | ✓                    | ✓                    | ✓                            | —                            | —                            | —                            |
| Live Smoke                | —                   | ✓                    | ✓                    | **Live proof not published** | **Live proof not published** | **Live proof not published** | **Live proof not published** |

Cloudflare's nightly run covers nine primitives, including Rate Limit. Vercel covers eight because ViteHub has no native Vercel Rate Limit driver. Browser and Agent routes have contract tests but are outside those deployed runs.

## Qualifications

- **Local Vite:** Active integrations expose their package imports and generated registries. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` provide local state. A local build can still generate output for an explicit or inferred hosted provider.
- **Cloudflare:** Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Browser and Agent have package-owned output outside the nightly run. Enabled integrations compose the Worker, `wrangler.json`, bindings, callbacks, and runtime modules. ViteHub can provision R2 buckets, D1 databases, and Cloudflare Queues.
- **Vercel:** Blob, Database, KV, Queue, Sandbox, Schedule, Workflow, and Workspace run in the live playground. Agent routes have separate package output outside the nightly run. Enabled integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules. ViteHub can create a Blob store and configure the project environment.
- **Netlify:** Blob uses `netlify-blobs`. Agent HTTP routes and static Schedules write functions under `.netlify/v1/functions`. CI runs the real-project fixture through Netlify CLI. ViteHub does not provide Netlify provisioning or published live proof.
- **Deno:** Agent chat and webhook routes, static Schedule wake output, and KV with `deno-kv` are supported with their documented permissions. Agent and Schedule write Deno entrypoints, but ViteHub does not generate a general Deno bundle or publish live proof.
- **Nitro and UnJS:** Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring are package-owned integrations. Nitro is integration glue rather than a storage or execution provider. ViteHub does not provide Nitro provisioning or one unified live matrix.
- **Node and self-hosted:** Server APIs and handlers run when their selected driver supports Node. Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` are single-process providers. ViteHub does not emit one Node deployment bundle, provision a self-hosted plan, or publish one live suite.

Local memory and filesystem providers stay single-process after deployment. Generated files remain package-owned and must not be imported by application code.
