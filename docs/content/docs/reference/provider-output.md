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
| Generated Runtime Registry | Local and hosted | Package that discovers Definitions | Maps Discovery Identity to lazy-loaded Definitions. |
| Generated Nitro handler or plugin | Nitro-shaped hosts | Package that requires a host bridge | Registers package-owned routes or runtime hooks. |
| Provision State | Local development and build input | ViteHub CLI plus package Provision Steps | Stores non-secret provider ids under `.vitehub/provision.json`. |

## Generation timing

Provider Output is written during production-shaped builds.
Vite dev usually proves discovery and local generated files; builds prove deployable host artifacts.

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

| Do | Avoid |
| --- | --- |
| Call `runQueue('welcome-email', payload)`. | Import a generated queue consumer from `.vitehub`. |
| Import `useServerEnv()` from `#vitehub/env/server`. | Import `.vitehub/env/server.mjs` directly. |
| Inspect `.vercel/output` during deployment debugging. | Treat `.vercel/output` files as source files to edit. |

## Related

- [Cloudflare](/docs/frameworks-hosts/cloudflare)
- [Vercel](/docs/frameworks-hosts/vercel)
- [Verification](/docs/development/verification)
