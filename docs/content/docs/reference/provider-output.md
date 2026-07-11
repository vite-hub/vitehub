---
title: Provider output
description: Reference generated deployment and runtime artifacts owned by ViteHub package integrations.
navigation.order: 54
icon: i-lucide-cloud-upload
---

Provider Output is generated deployment or runtime artifacts required by a provider.
It belongs to the package that owns the primitive and should not become application authoring surface.

## Output families

| Output | Provider | Owner | Purpose |
| --- | --- | --- | --- |
| Worker bundle | Cloudflare | Package integration using Cloudflare output | Runs server or primitive runtime code in Workers. |
| `wrangler.json` entries | Cloudflare | Blob, Database, Queue, Schedule, Workflow, Sandbox, Agent state as applicable | Declares bindings, crons, durable objects, queues, and other worker config. |
| Vercel Build Output | Vercel | Package integration using Vercel output | Writes functions, static files, routes, and function config under `.vercel/output`. |
| Netlify function output | Netlify | Agent and Schedule Packages | Writes generated functions and static config under `.netlify/v1`. |
| Deno Agent server output | Deno | Agent Package | Writes `.vitehub/agent/deno-server.ts` for `Deno.serve` chat and webhook routes. |
| Deno cron output | Deno | Schedule Package | Writes `.vitehub/schedule/deno-cron.mjs` for `Deno.cron` static schedule wake output. |
| Generated Runtime Registry | Local and hosted | Package that discovers Definitions | Maps Discovery Identity to lazy-loaded Definitions. |
| Generated Nitro handler or plugin | Nitro-shaped hosts | Package that requires a host bridge | Registers package-owned routes or runtime hooks. |
| Provision State | Local development and build input | ViteHub CLI plus package Provision Steps | Stores non-secret provider ids under `.vitehub/provision.json`. |

## Generation timing

Provider Output is normally written during production-shaped builds. Vite dev proves discovery and local generated files; Netlify local development also materialises package functions for Netlify CLI.

```bash [Terminal]
pnpm build
find .vitehub -maxdepth 4 -type f | sort
find .vercel/output -maxdepth 4 -type f | sort
find dist -maxdepth 4 -type f | sort
```

## Provider Output Contracts

Provider Output Contracts assert generated artifact shape without deploying to a cloud account.
Use them for bindings, emitted functions, generated worker config, bundle purity, cron entries, and selected provider dependency reachability.

```bash [Terminal]
pnpm --filter @vite-hub/database test
pnpm --filter @vite-hub/workflow test
```

## Public boundary

Application code should import Runtime Helpers and stable handlers.
Generated Provider Output may import generated files, virtual modules, or provider runtime packages internally.

Netlify Agent output is Provider Output, not an app import: there is no stable `@vite-hub/agent/netlify` import. Inspect `.netlify/v1/functions/vitehub-agent.mjs` and `.vitehub/agent/netlify-function.mjs` during deployment debugging instead of importing them from application code.

| Do | Avoid |
| --- | --- |
| Call `runQueue('welcome-email', payload)`. | Import a generated queue consumer from `.vitehub`. |
| Import `useServerEnv()` from `#vitehub/env/server`. | Import `.vitehub/env/server.mjs` directly. |
| Inspect `.vercel/output` during deployment debugging. | Treat `.vercel/output` files as source files to edit. |

## Related

- [Cloudflare](/docs/frameworks-hosts/cloudflare)
- [Vercel](/docs/frameworks-hosts/vercel)
- [Netlify](/docs/frameworks-hosts/netlify)
- [Deno](/docs/frameworks-hosts/deno)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Verification](/docs/development/verification)
