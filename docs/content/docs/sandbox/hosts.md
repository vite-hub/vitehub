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

### Size

Set the size of the machine that runs every Sandbox Task with `cpu` and `memory`. The two options work the same on both providers.

```ts [vite.config.ts]
hubSandboxTask({ provider: 'cloudflare', cpu: 1, memory: 4096 })
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

`vitehub inspect definitions` shows the size on each Sandbox Task. On Cloudflare, `vitehub inspect resources` also shows the instance type and the instance limit of the Container.

### Vercel options

| Option | Default | Description |
| --- | --- | --- |
| `runtime` | `'node24'` | Runtime image. With a `snapshot` source, the snapshot sets the runtime, so ViteHub sends none unless you set one. |
| `timeout` | - | Session timeout in milliseconds. A task timeout wins: the session then gets the task timeout plus 30 seconds for Sandbox setup and cleanup. |
| `ports` | - | Ports to expose. |
| `source` | - | Source to load. |
| `networkPolicy` | - | Network policy. |
| `token`, `teamId`, `projectId` | - | Credentials. Or set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`, or use the project environment. |

### Cloudflare options

| Option | Default | Description |
| --- | --- | --- |
| `binding` | `'SANDBOX'` | Durable Object binding name. |
| `className` | `'Sandbox'` | Exported Durable Object class name. |
| `migrationTag` | `'v1'` | Unique Wrangler migration tag for the class. |
| `name` | - | Container name. The `cloudflare` host builds it from the app name. |
| `maxInstances` | `12` | Maximum number of Containers that run at the same time. Your own `containers` entry can set `max_instances` instead. If both are set and differ, the build fails with `SANDBOX_TASK_CLOUDFLARE_MAX_INSTANCES_CONFLICT`. |
| `sandboxId` | - | One Sandbox ID for every run. |
| `sleepAfter` | `'10m'` | Idle time before Cloudflare stops the Container: seconds, or a value such as `'30s'`, `'5m'`, or `'1h'`. |
| `keepAlive` | `false` | Keep the Container running for up to 6 idle hours between requests (the Cloudflare maximum). ViteHub then closes the session after each run. |
| `normalizeId` | `false` | Lowercase the Sandbox ID before it names the Durable Object. |

On Cloudflare, ViteHub writes the Container, Durable Object binding, migration, and Worker exports to Provider Output (the generated host files). It writes `.vitehub/sandbox-task/Dockerfile` when the container has no image.

The generated image runs `tini` as its first process, so it collects the processes that commands leave behind. ViteHub starts each spawned command in its own process group with bash job control, so a kill or a timeout also stops its child processes.

For a custom image, give your container a complete Dockerfile that copies `/usr/local/bin/sandbox-shim` from `docker.io/cloudflare/sandbox:<installed @cloudflare/sandbox version>`. Keep `bash` in the image. It is the only tool that process groups need. Use an init process such as `tini` as the entrypoint. Without an init, processes that commands leave behind stay as zombies. On Vercel, set `runtime` or `source`. There is no helper for partial Dockerfiles, because image syntax differs between providers.

## Related guides

Read [Choose Cloudflare Sandbox or Vercel Sandbox](/docs/guides/sandbox-providers) to compare setup, boundaries, and checks.
