---
title: Runtime and host support
description: Check which ViteHub contracts exist for each host and how the repository proves them.
navigation.title: Support matrix
navigation.order: 41
icon: i-lucide-table-properties
---

ViteHub portability is a set of separate contracts. A package can expose an app-facing Runtime Helper without generating a complete deployment bundle, and Provider Output can exist for one primitive without existing for every ViteHub package.

Use this matrix to choose a runtime boundary. **Package-specific** always means that the named package contract, rather than the host alone, determines support.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Available** | ViteHub exposes the contract as a current public surface. |
| **Package-specific** | Only the packages or outputs named in the cell provide the contract. |
| **Local-only** | The provider is suitable for development or one local process, but it does not promise distributed durability. |
| **Not provided** | ViteHub does not provide this contract for the host. |

Proof labels describe repository coverage, not a blanket production guarantee. **Contract-tested** means source tests assert the generated or runtime contract. A Local Provider Run executes built output without a cloud account. A Live Smoke deploys the shared primitive playground to a real provider.

## Current support

| Host | App-facing Runtime Helpers | Local providers | Generated Provider Output | Provision support | Production proof |
| --- | --- | --- | --- | --- | --- |
| Local Vite | **Available.** Active package integrations expose their package imports and generated registries. | **Available.** Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` cover common local state. | **Not provided** as a Local Vite target. An explicit or inferred hosted provider can still generate that provider's output during a local build. | **Not provided** | **Contract-tested** through package and docs CI; this row makes no hosted-runtime claim. |
| Cloudflare | **Package-specific.** The live primitive playground covers Blob, Database, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace. Browser adds Cloudflare Browser Run support; Agent routes have separate package output. | **Package-specific.** Pull requests build Cloudflare output and run the primitive playground locally. Browser also has provider-output contract tests. | **Package-specific.** Enabled integrations compose a Worker, `wrangler.json`, Browser Run bindings, Rate Limiting bindings, callbacks, and runtime modules. | **Package-specific.** R2 buckets, D1 databases, and Cloudflare Queues. Browser Run and Rate Limiting bindings require no separate provisioned resource. | **Contract-tested**, followed by a Local Provider Run in CI. A nightly Live Smoke deploys the nine named primitives; it does not currently prove Browser or Agent routes. |
| Vercel | **Package-specific.** The live primitive playground covers Blob, Database, KV, Queue, Sandbox, Schedule, Workflow, and Workspace. Agent routes have separate package output. | **Package-specific.** Pull requests build Vercel output and run the primitive playground against local service adapters. | **Package-specific.** Enabled integrations write Vercel Build Output, functions, routes, cron entries, and runtime modules. | **Package-specific.** Vercel Blob store creation and project environment setup, with `VERCEL_TOKEN` and `VERCEL_PROJECT_ID`. | **Contract-tested**, followed by a Local Provider Run in CI. A nightly Live Smoke deploys the eight named primitives; it does not currently prove Agent routes. |
| Netlify | **Package-specific.** Blob uses `netlify-blobs`; Agent HTTP routes and static Schedules have generated function output. | **Package-specific.** CI runs the real-project fixture through Netlify CLI. | **Package-specific.** Agent and Schedule packages write functions under `.netlify/v1/functions`. | **Not provided** | **Contract-tested** with Netlify CLI E2E. **Live proof not published**. |
| Deno | **Package-specific.** Agent chat and webhook routes, static Schedule wake output, and KV with `deno-kv`. | **Package-specific.** `deno-kv` and the generated Agent or Schedule output can run locally with their documented Deno permissions. | **Package-specific.** `.vitehub/agent/deno-server.ts` and `.vitehub/schedule/deno-cron.mjs`; no general ViteHub Deno bundle. | **Not provided** | **Contract-tested** in Agent and Schedule package tests. **Live proof not published**. |
| Nitro and UnJS | **Package-specific.** Auth and Agent handlers, the Schedule Nitro bridge, Workspace runtime setup, and Database Nuxt D1 wiring. | **Not provided.** Nitro is host integration glue, not a ViteHub storage or execution provider. | **Package-specific.** Package integrations generate Nitro handlers, plugins, or configuration only where listed. | **Not provided** | **Contract-tested** at the owning package boundaries. **Live proof not published** as one unified Nitro matrix. |
| Node and self-hosted | **Package-specific.** Server APIs and handlers run when their selected driver supports Node. | **Local-only.** Blob `fs`, KV `fs-lite`, Rate Limit `memory`, and Workspace `local` or `memory` do not provide cross-instance durability; configure a durable provider for production state. | **Not provided.** ViteHub does not emit one unified Node deployment bundle. | **Not provided** | **Contract-tested** per package. **Live proof not published** as one self-hosted deployment suite. |

## Evidence behind the matrix

The matrix follows source and executable proof rather than provider marketing:

- Preset composition and Queue opt-in: [`packages/vite-hub/src/index.ts`](https://github.com/vite-hub/vitehub/blob/main/packages/vite-hub/src/index.ts) and [`packages/vite-hub/test/vite.test.ts`](https://github.com/vite-hub/vitehub/blob/main/packages/vite-hub/test/vite.test.ts).
- Cloudflare and Vercel pull-request proof: [`.github/workflows/ci.yml`](https://github.com/vite-hub/vitehub/blob/main/.github/workflows/ci.yml).
- Cloudflare and Vercel deployed primitive proof: [`.github/workflows/live-smoke.yml`](https://github.com/vite-hub/vitehub/blob/main/.github/workflows/live-smoke.yml).
- Netlify local proof: the `verify-netlify` job in [`.github/workflows/ci.yml`](https://github.com/vite-hub/vitehub/blob/main/.github/workflows/ci.yml).
- Provider Output contracts: the `vite-output` or `provider-output` tests in the Blob, Browser, Database, KV, Queue, Rate Limit, Schedule, and Workflow packages, plus Agent provider tests.
- Provision boundaries: `packages/blob/src/provision.ts`, `packages/database/src/provision.ts`, and `packages/queue/src/provision.ts`. The CLI accepts only Cloudflare and Vercel provider plans.

## Limits

- A host row does not imply that every primitive supports that host.
- Generated output remains package-owned. Do not import `.vitehub/**`, `.vercel/output/**`, `.netlify/v1/**`, or generated Worker files from application code.
- Rate Limit `memory` is local and single-process. Cloudflare native enforcement is best-effort, supports only the provider periods accepted by the Rate Limit integration, and does not promise complete quota metadata.
- Realtime `memory` is development or explicit single-process state. Cloudflare Realtime routes use one Durable Object authority and persist Yjs room identities in its SQLite storage; Vercel and Netlify have no built-in Realtime authority.
- Memory and filesystem defaults do not become production-durable because the surrounding application is deployed.
- The Cloudflare Live Smoke exercises nine primitives, including Rate Limit. Vercel exercises the other eight because ViteHub does not provide a native Vercel Rate Limit driver. Agent route output has contract tests, but it is outside that deployed matrix.

## Related pages

- [Provider output](/docs/reference/provider-output)
- [Config options](/docs/reference/config-options)
- [Verification](/docs/development/verification)
