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
| Vercel Sandbox | `hubSandboxTask({ provider: 'vercel' })` or the `vercel` host | Vercel. Other hosts, such as Netlify, with Vercel credentials set. |
| Cloudflare Sandbox | `hubSandboxTask({ provider: 'cloudflare' })` or the `cloudflare` host | Cloudflare Workers with the generated Container and Durable Object binding. |

The `deno`, `netlify`, and `node` hosts have no built-in Sandbox provider, so `vitehub({ host, sandboxTask: true })` fails at config time. Without a `provider`, the runtime detects Cloudflare or Vercel from the environment. Both providers run remote machines that may bill you. There is no local provider.

The Vercel provider works in the Vite or Nuxt dev server when Vercel credentials are set. The Cloudflare provider does not, because the dev server cannot host a Container. The `cloudflare` host writes the Durable Object and Container only to `.output/server/wrangler.json`. Build, then run `npx wrangler dev --config .output/server/wrangler.json`. Wrangler needs Docker.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Runtime image. With a `snapshot` source, the snapshot sets the runtime, so ViteHub sends none unless you set one. |
| `timeout` | - | Session timeout in milliseconds. A task timeout wins: the session then gets the task timeout plus 30 seconds for Sandbox setup and cleanup. |
| `cpu` | - | vCPU count. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load. |
| `networkPolicy` | `'allow-all'` | Outbound traffic. See [Network policy](#network-policy). Vercel also takes `subnets`. |
| `token`, `teamId`, `projectId` | - | Credentials. Or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Unique Wrangler migration tag for the class. |
| `name` | - | Container name. The `cloudflare` host builds it from the app name. |
| `sandboxId` | - | One Sandbox ID for every run. |
| `sleepAfter` | `'10m'` | Idle time before Cloudflare stops the Container: seconds, or a value such as `'30s'`, `'5m'`, or `'1h'`. |
| `keepAlive` | `false` | Keep the Container running for up to 6 idle hours between requests (the Cloudflare maximum). ViteHub then closes the session after each run. |
| `normalizeId` | `false` | Lowercase the Sandbox ID before it names the Durable Object. |
| `networkPolicy` | `'allow-all'` | Outbound traffic. See [Network policy](#network-policy). |

On Cloudflare, ViteHub writes the Container, Durable Object binding, migration, and Worker exports to Provider Output (the generated host files). It writes `.vitehub/sandbox-task/Dockerfile` when the container has no image.

The generated image runs `tini` as its first process, so it collects the processes that commands leave behind. ViteHub starts each spawned command in its own process group with bash job control, so a kill or a timeout also stops its child processes.

For a custom image, give your container a complete Dockerfile that copies `/usr/local/bin/sandbox-shim` from `docker.io/cloudflare/sandbox:<installed @cloudflare/sandbox version>`. Keep `bash` in the image. It is the only tool that process groups need. Use an init process such as `tini` as the entrypoint. Without an init, processes that commands leave behind stay as zombies. On Vercel, set `runtime` or `source`. There is no helper for partial Dockerfiles, because image syntax differs between providers.

## Network policy

Both providers take the same `networkPolicy`:

```ts [vite.config.ts]
import { hubSandboxTask } from '@vite-hub/sandbox/task/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSandboxTask({
      provider: 'cloudflare',
      networkPolicy: { allow: ['registry.npmjs.org', '*.github.com'] },
    }),
  ],
})
```

| Value | Outbound traffic | `executionAuthority.network` |
| --- | --- | --- |
| `'allow-all'` (default) | All traffic. | `'unrestricted'` |
| `'deny-all'` | No traffic. Package installs fail too. | `'none'` |
| `{ allow: [...] }` | HTTP and HTTPS to the listed hostnames only. Other hosts and protocols fail. | `'restricted'` |

`'*.example.com'` matches subdomains only, not `example.com`. Add `registry.npmjs.org` when a task installs packages.

On Vercel, the Sandbox matches HTTPS hosts by TLS SNI and does not decrypt the traffic.

On Cloudflare, the generated Worker exports a `SandboxOutbound` entrypoint. Cloudflare sends HTTP on port 80 and HTTPS on port 443 to an allowed host through it, and decrypts that HTTPS traffic with its own CA. ViteHub sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, and `GIT_SSL_CAINFO` on every command, so Node.js, curl, Python, and Git trust that CA. Other tools must use one of these variables. Names of other hosts do not resolve. The list takes at most 64 hostnames and no IP addresses. The Worker needs a `compatibility_date` of `2025-11-17` or later.

Cloudflare applies the policy when the Container starts, so the policy belongs to the Sandbox, not to the container class. When a shared `sandboxId` opens with another policy, ViteHub stops its Container and starts a new one. Files and processes in the old Container are lost.

## Related guides

Read [Choose Cloudflare Sandbox or Vercel Sandbox](/docs/guides/sandbox-providers) to compare setup, boundaries, and checks.
