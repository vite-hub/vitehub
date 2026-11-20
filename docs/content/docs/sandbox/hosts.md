---
title: Sandbox hosts
description: Sandbox providers, host support, provider options, and Provider Output.
navigation.title: Hosts
navigation.order: 7
icon: i-lucide-cloud-cog
---

## Drivers

Choose the provider in app or host config, not in the task.

| Driver | Configure with | Host support |
| --- | --- | --- |
| Vercel Sandbox | The `vercel` host, or `sandboxTask: { driver: 'vercel' }` | Vercel. Other hosts, such as Node and Netlify, with Vercel credentials set. |
| Cloudflare Sandbox | The `cloudflare` host | Cloudflare Workers with the generated Container and Durable Object binding. |

`sandboxTask: true` uses the Sandbox of the host. The `deno`, `netlify`, and `node` hosts have no built-in Sandbox provider, so `sandboxTask: true` fails at config time there. Set `sandboxTask: { driver: 'vercel' }` to use Vercel Sandbox on the `node` or `netlify` host. `driver: 'cloudflare'` works only on the `cloudflare` host. Both providers run remote machines that may bill you. There is no local provider.

To set provider options, give `sandboxTask` an object with the `driver` and the options from the tables below. The Nuxt module takes the same object in its `vitehub` options.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'cloudflare',
    sandboxTask: { driver: 'cloudflare', keepAlive: true, sleepAfter: '30m' },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'cloudflare',
      sandboxTask: { driver: 'cloudflare', keepAlive: true, sleepAfter: '30m' },
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({
    host: 'cloudflare',
    sandboxTask: { driver: 'cloudflare', keepAlive: true, sleepAfter: '30m' },
  })],
})
```
:::
::

Apps that do not use `vite-hub` pass the same object to `hubSandboxTask()` from `@vite-hub/sandbox/task/vite`. Do not add `hubSandboxTask()` next to `vitehub()`: the `vite-hub` app then has no Sandbox Tasks.

### Development

On macOS, Linux, or WSL, the Vite or Nuxt dev server runs each Sandbox Task as a Node process on your computer, in a temporary folder that the run removes. You need no Vercel credentials and no Docker. The process is not isolated: it can read your files and use your network, and `executionAuthority` reports `isolation: 'none'`.

For Cloudflare apps, use Nitro's `node-worker` dev runner (`nitro.devServer.runner: 'node-worker'`). The `miniflare` dev runner cannot start Node processes. On native Windows, use WSL or run against the provider as described below.

To run the tasks in the host's Sandbox during development, set `remote: true`:

```ts fragment
sandboxTask: { driver: 'vercel', remote: true }
```

With `remote: true`, the Vercel provider needs Vercel credentials. The Cloudflare provider still cannot run in the dev server, because the dev server cannot host a Container. The `cloudflare` host writes the Durable Object and Container only to `.output/server/wrangler.json`. Build, then run `npx wrangler dev --config .output/server/wrangler.json`. Wrangler needs Docker.

### Size

Set the size of the machine that runs every Sandbox Task with `cpu` and `memory` in `sandboxTask`. The two options work the same on both providers.

```ts fragment
sandboxTask: { driver: 'cloudflare', cpu: 1, memory: 4096 }
```

| Option | Type | Description |
| --- | --- | --- |
| `cpu` | `number` | Minimum vCPUs, such as `2` or `0.5`. |
| `memory` | `number` | Minimum memory in MiB, such as `4096`. |

Both values are minimums. ViteHub picks the smallest provider size that gives at least `cpu` and at least `memory`:

| Provider | Size that ViteHub picks | Default | Largest |
| --- | --- | --- | --- |
| Vercel | `resources.vcpus`. Vercel gives 2048 MiB for each vCPU, so ViteHub uses the larger of `cpu` and `memory / 2048`, rounded up to 1 or the next even number. | Vercel default: 2 vCPU, 4096 MiB | 32 vCPU. Your Vercel plan can allow fewer. |
| Cloudflare | The smallest instance type from `lite`, `basic`, `standard-1`, `standard-2`, `standard-3`, and `standard-4` that fits both values. | `standard-1`: 1/2 vCPU, 4096 MiB | `standard-4`: 4 vCPU, 12288 MiB |

A size above the largest fails the build with `SANDBOX_TASK_SIZE_TOO_LARGE`.

On Cloudflare, the size belongs to the Container class in `wrangler.json`, so it applies to every Sandbox Task of the app. It is not a per-run value. When your own `containers` entry sets `instance_type`, ViteHub keeps it. If that instance type is smaller than `cpu` or `memory`, the build fails with `SANDBOX_TASK_CLOUDFLARE_INSTANCE_TYPE_TOO_SMALL`. ViteHub does not change your entry, and it does not let a task run with less memory than you asked for.

On Cloudflare, `vitehub inspect resources` shows the instance type and the instance limit of the Container.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Runtime image. With a `snapshot` source, the snapshot sets the runtime, so ViteHub sends none unless you set one. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load. |
| `networkPolicy` | `'allow-all'` | Outbound traffic. See [Network policy](#network-policy). Vercel also takes `subnets`. |
| `token`, `teamId`, `projectId` | - | Credentials. Or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Wrangler migration tag that creates the Durable Object class. Set it when you deploy onto an existing Worker whose last migration tag is not `v1`, else the deploy fails with Cloudflare error 10074. |
| `name` | - | Container name. The `cloudflare` host builds it from the app name. |
| `maxInstances` | `12` | Maximum number of Containers that run at the same time. Your own `containers` entry can set `max_instances` instead. If both are set and differ, the build fails with `SANDBOX_TASK_CLOUDFLARE_MAX_INSTANCES_CONFLICT`. |
| `sandboxId` | - | One Sandbox ID for every run. The Sandbox stays after each run until it is idle for `sleepAfter`. |
| `sleepAfter` | `'5m'` | Idle time before Cloudflare stops the Container: seconds, or a value such as `'30s'`, `'5m'`, or `'1h'`. |
| `keepAlive` | `false` | Set the idle time to 6 hours, the Cloudflare maximum. Use it with `sandboxId` to keep a warm Sandbox between runs. A Sandbox without `sandboxId` still stops after each run. |
| `normalizeId` | `false` | Lowercase the Sandbox ID before it names the Durable Object. |
| `networkPolicy` | `'allow-all'` | Outbound traffic. See [Network policy](#network-policy). |

On Cloudflare, ViteHub writes the Container, Durable Object binding, migration, and Worker exports to Provider Output (the generated host files). It writes `.vitehub/sandbox-task/Dockerfile` when the container has no image.

The generated image runs `tini` as its first process, so it collects the processes that commands leave behind. ViteHub starts each spawned command in its own process group with bash job control, so a kill or a timeout also stops its child processes.

For a custom image, give your container a complete Dockerfile that copies `/usr/local/bin/sandbox-shim` from `docker.io/cloudflare/sandbox:<installed @cloudflare/sandbox version>`. Keep `bash` in the image. It is the only tool that process groups need. Use an init process such as `tini` as the entrypoint. Without an init, processes that commands leave behind stay as zombies. On Vercel, set `runtime` or `source`. There is no helper for partial Dockerfiles, because image syntax differs between providers.

## Network policy

Both providers take the same `networkPolicy`. The local dev runner cannot enforce network restrictions. It rejects `deny-all`, hostname allowlists, and Vercel subnet policies before starting a task. To develop with a restrictive policy, use `remote: true` on Vercel or the Wrangler setup above on Cloudflare.

```ts [vite.config.ts]
import { hubSandboxTask } from '@vite-hub/sandbox/task/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubSandboxTask({
      driver: 'cloudflare',
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

On Cloudflare, the generated Worker exports a `SandboxOutbound` entrypoint. Cloudflare sends HTTP on port 80 and HTTPS on port 443 to an allowed host through it, and decrypts that HTTPS traffic with its own CA. The entrypoint checks the request host against the list again and answers 403 for other hosts, so a `Host` header that differs from the TLS server name cannot reach them. ViteHub sets `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`, and `GIT_SSL_CAINFO` on every command, so Node.js, curl, Python, and Git trust that CA. Other tools must use one of these variables. Names of other hosts do not resolve. The list takes at most 64 hostnames and no IP addresses. The Worker needs a `compatibility_date` of `2025-11-17` or later.

Cloudflare applies the policy when the Container starts, so the policy belongs to the Sandbox, not to the container class. When a shared `sandboxId` opens with another policy, ViteHub stops its Container and starts a new one. Files and processes in the old Container are lost.

## Related guides

Read [Choose Cloudflare Sandbox or Vercel Sandbox](/docs/guides/sandbox-providers) to compare setup, boundaries, and checks.
