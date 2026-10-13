---
title: Sandbox hosts
description: Sandbox providers, host support, provider options, and Provider Output.
navigation.title: Hosts
navigation.order: 7
icon: i-lucide-cloud-cog
---

## Providers

Provider selection belongs to application or host configuration, not to a Definition.

| Provider | Configure with | Host support |
| --- | --- | --- |
| Vercel Sandbox | `hubSandbox({ provider: 'vercel' })` or the `vercel` preset | Vercel. Other hosts, such as Netlify, when Vercel credentials are set. |
| Cloudflare Sandbox | `hubSandbox({ provider: 'cloudflare' })` or the `cloudflare` preset | Cloudflare Workers with the generated Container and Durable Object binding. |

The `deno`, `netlify`, and `node` presets have no built-in Sandbox provider, so `vitehub({ preset, sandbox: true })` fails during configuration for them. Without an explicit `provider`, the runtime detects Cloudflare or Vercel from the environment. Both providers run remote, potentially billed infrastructure. Sandbox has no local in-process provider.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Vercel Sandbox runtime image. |
| `timeout` | - | Provider session timeout in milliseconds. A Definition timeout takes priority. |
| `cpu` | - | vCPU count. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load into the Box. |
| `networkPolicy` | - | Network policy for the Box. |
| `token`, `teamId`, `projectId` | - | Credentials. Otherwise, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Wrangler migration tag for the class. Must be unique. |
| `name` | - | Container name. The `cloudflare` preset derives one from the app name. |
| `sandboxId` | - | Shared Box identity for every run. |
| `sleepAfter`, `keepAlive`, `normalizeId` | - | Cloudflare Sandbox session options. |

The Cloudflare integration writes the Container, Durable Object binding, migration, and Worker exports to Provider Output. It generates `.vitehub/sandbox/Dockerfile` when the container has no image. For a custom image, configure the application-owned container with a complete Dockerfile. For Vercel, set `runtime` or `source`. Sandbox has no Dockerfile-fragment helper because partial image syntax is not portable across providers.
