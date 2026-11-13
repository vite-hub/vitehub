---
title: Provider output
description: The deploy and runtime files that ViteHub packages generate for each host.
navigation.order: 56
navigation.group: Runtime and output
icon: i-lucide-cloud-upload
---

Provider Output is the files ViteHub generates so a host can deploy and run your app. Each primitive's package writes its own. Do not edit or import them.

## Output families

| Output | Provider | Owner | Purpose |
| --- | --- | --- | --- |
| `deployment.json` | All built-in hosts | `vite-hub` | Deployment identity and source, with host, runtime, output, and service contract. |
| Worker bundle | Cloudflare | Packages with Cloudflare output | Runs server and primitive code in Workers. |
| `wrangler.json` entries | Cloudflare | Blob, Database, Queue, Rate Limit, Schedule, Workflow, Sandbox, Agent state | Bindings, crons, durable objects, queues, Rate Limiting bindings, and other Worker config. |
| Vercel Build Output | Vercel | Packages with Vercel output | Functions, static files, routes, and function config in `.vercel/output`. |
| Netlify function output | Netlify | Agent and Schedule Packages | Functions and static config in `.netlify/v1`. |
| Deno Agent server output | Deno | Agent Package | `.vitehub/agent/deno-server.ts` for `Deno.serve` chat and webhook routes. |
| Deno cron output | Deno | Schedule Package | `.vitehub/schedule/deno-cron.mjs`, which wakes static schedules with `Deno.cron`. |
| Rate Limit manifest | Local and hosted | Rate Limit Package | `.vitehub/rate-limit/manifest.json` with sorted Rate Limit IDs, providers, and driver capabilities. |
| Generated Runtime Registry | Local and hosted | Packages that discover Definitions | Maps each discovered name to a lazy-loaded Definition. |
| Generated Nitro handler or plugin | Nitro-shaped hosts | Packages that need a host bridge | Registers package routes or runtime hooks. |
| Provision State | Local dev and build input | ViteHub CLI and package Provision Steps | Non-secret provider ids in `.vitehub/provision.json`. |

## Generation timing

Production builds write Provider Output. Vite dev writes only discovery and local generated files. Netlify local dev also writes package functions for the Netlify CLI.

`vitehub inspect output` lists the files of the active packages and the host, and which exist. `--json` adds parsed JSON content, with credentials and Worker `vars` hidden. See the [CLI guide](/docs/development/cli#inspect-definitions-and-provider-output).

```bash [Terminal]
pnpm build
pnpm vitehub inspect output
find .vitehub -maxdepth 4 -type f | sort
find .vercel/output -maxdepth 4 -type f | sort
find dist -maxdepth 4 -type f | sort
```

### Rate Limit output

Rate Limit writes `.vitehub/rate-limit/manifest.json` when Vite resolves its config, and updates it with the rest of Provider Output. This `schemaVersion: 2` file holds sorted `rateLimits` entries shaped as `{ name, provider, capabilities }`. Inspect it before deploy. Do not import it.

On Cloudflare, each `requireRateLimit()` policy in a handler adds a `ratelimits` entry to `wrangler.json`, with a ViteHub binding name, a stable namespace id, the static `limit`, and a 10-second or 60-second period.

Rate Limit owns only the binding names it makes from declared stable IDs. It keeps other entries. It removes old ones when you rename or delete a handle, or build for another provider with Rate Limit still on.

Call `requireRateLimit()` with the H3 event. Do not store the generated binding name in your source.

## Provider Output Contracts

These tests check generated files without a deploy: bindings, emitted functions, Worker config, bundle purity, cron entries, and reachable provider dependencies.

```bash [Terminal]
pnpm --filter @vite-hub/database test
pnpm --filter @vite-hub/workflow test
```

## Public boundary

Your code imports Runtime Helpers and documented handlers. Provider Output may import generated files, virtual modules, or provider runtime packages.

Netlify Agent output is not an application import. There is no stable `@vite-hub/agent/netlify` import. To debug a deploy, inspect `.netlify/v1/functions/vitehub-agent.mjs` and `.vitehub/agent/netlify-function.mjs`.

Nuxt writes generated Agent files to `<buildDir>/vitehub/agent` (usually `.nuxt/vitehub/agent`). The Netlify wrapper and Deno entrypoint are there. The `.netlify/v1` output and other `.vitehub` output do not move.

| Do | Avoid |
| --- | --- |
| Call `sendQueue('welcome-email', payload)`. | Import a generated queue consumer from `.vitehub`. |
| Import `useServerEnv()` from `#vitehub/env/server`. | Import `.vitehub/env/server.mjs` directly. |
| Inspect `.vercel/output` to debug a deploy. | Edit `.vercel/output` files as source. |

## Related

- [Cloudflare](/docs/frameworks-hosts/cloudflare)
- [Vercel](/docs/frameworks-hosts/vercel)
- [Netlify](/docs/frameworks-hosts/netlify)
- [Deno](/docs/frameworks-hosts/deno)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Verification](/docs/development/verification)
