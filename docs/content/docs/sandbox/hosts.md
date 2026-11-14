---
title: Sandbox hosts
description: Sandbox providers, host support, provider options, and Provider Output.
navigation.title: Hosts
navigation.order: 7
icon: i-lucide-cloud-cog
---

## Providers

Choose the provider in app or host config, not in the task.

| Provider | Configure with | Host support |
| --- | --- | --- |
| Vercel Sandbox | The `vercel` host, or `sandboxTask: { provider: 'vercel' }` | Vercel. Other hosts, such as Node and Netlify, with Vercel credentials set. |
| Cloudflare Sandbox | The `cloudflare` host | Cloudflare Workers with the generated Container and Durable Object binding. |

`sandboxTask: true` uses the Sandbox of the host. The `deno`, `netlify`, and `node` hosts have no built-in Sandbox provider, so `sandboxTask: true` fails at config time there. Set `sandboxTask: { provider: 'vercel' }` to use Vercel Sandbox on the `node` or `netlify` host. `provider: 'cloudflare'` works only on the `cloudflare` host. Both providers run remote machines that may bill you. There is no local provider.

To set provider options, give `sandboxTask` an object with the `provider` and the options from the tables below. The Nuxt module takes the same object in its `vitehub` options.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    sandboxTask: { provider: 'cloudflare', keepAlive: true, sleepAfter: '30m' },
  })],
})
```

Apps that do not use `vite-hub` pass the same object to `hubSandboxTask()` from `@vite-hub/sandbox/task/vite`. Do not add `hubSandboxTask()` next to `vitehub()`: the `vite-hub` app then has no Sandbox Tasks.

The Vercel provider works in the Vite or Nuxt dev server when Vercel credentials are set. The Cloudflare provider does not, because the dev server cannot host a Container. The `cloudflare` host writes the Durable Object and Container only to `.output/server/wrangler.json`. Build, then run `npx wrangler dev --config .output/server/wrangler.json`. Wrangler needs Docker.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Runtime image. |
| `timeout` | - | Session timeout in milliseconds. A task timeout wins: the session then gets the task timeout plus 30 seconds for Sandbox setup and cleanup. |
| `cpu` | - | vCPU count. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load. |
| `networkPolicy` | - | Network policy. |
| `token`, `teamId`, `projectId` | - | Credentials. Or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Wrangler migration tag that creates the Durable Object class. Set it when you deploy onto an existing Worker whose last migration tag is not `v1`, else the deploy fails with Cloudflare error 10074. |
| `name` | - | Container name. The `cloudflare` host builds it from the app name. |
| `sandboxId` | - | One Sandbox ID for every run. |
| `sleepAfter` | `'10m'` | Idle time before Cloudflare stops the Container: seconds, or a value such as `'30s'`, `'5m'`, or `'1h'`. |
| `keepAlive` | `false` | Keep the Container running for up to 6 idle hours between requests (the Cloudflare maximum). ViteHub then closes the session after each run. |
| `normalizeId` | `false` | Lowercase the Sandbox ID before it names the Durable Object. |

On Cloudflare, ViteHub writes the Container, Durable Object binding, migration, and Worker exports to Provider Output (the generated host files). It writes `.vitehub/sandbox-task/Dockerfile` when the container has no image.

For a custom image, give your container a complete Dockerfile that copies `/usr/local/bin/sandbox-shim` from `docker.io/cloudflare/sandbox:<installed @cloudflare/sandbox version>`. On Vercel, set `runtime` or `source`. There is no helper for partial Dockerfiles, because image syntax differs between providers.

## Related guides

Read [Choose Cloudflare Sandbox or Vercel Sandbox](/docs/guides/sandbox-providers) to compare setup, boundaries, and checks.
