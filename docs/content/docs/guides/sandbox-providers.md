---
title: AI sandbox providers compared
description: Compare Vercel Sandbox, Cloudflare Sandbox, and self-hosted runtimes as an AI agent sandbox. See isolation, limits, pricing, and the ViteHub setup for each.
seo.title: Vercel Sandbox vs Cloudflare Sandbox for AI agents
navigation.title: Sandbox providers
navigation.order: 22
icon: i-lucide-scale
navigation.group: Server work
---

An AI sandbox runs code that a model or a user wrote, away from your server and its secrets. ViteHub has four built-in Sandbox runtimes. Vercel Sandbox and Cloudflare Sandbox isolate the code in the cloud. `trusted-host` and Crabbox run it on your own machine, without isolation.

Vendor facts below come from vendor docs on 2026-10-29. Limits and prices change, so check the linked pages before you decide.

::agent-only
Select the Sandbox runtime explicitly. Do not use `trusted-host` or Crabbox for untrusted code.

Before you rely on isolation, read `sandbox.plan.executionAuthority`, or `executionAuthority` from `resolveSandboxTaskRunner(name)`. Take vendor limits and prices from the linked vendor pages, not from this page.

Prove one successful run, one timeout, and cleanup on the selected runtime.
::

## What is an AI agent sandbox

An agent sandbox is where an agent's commands run: installs, tests, or generated code. It decides which files, network destinations, and credentials those commands can reach.

Approvals, tool policy, and Capabilities decide what the agent may do. The sandbox limits the damage when a command goes wrong.

## Compare sandbox providers

| | Vercel Sandbox | Cloudflare Sandbox | `trusted-host` | Crabbox |
| --- | --- | --- | --- | --- |
| Isolation | A Firecracker microVM with its own filesystem and network. | A container, run as a microVM with its own kernel and network. | None. Only the Home and environment are private. | None on the target host. |
| ViteHub reports | `isolation: 'microvm'` | `isolation: 'container'` | `isolation: 'none'` | `isolation: 'none'` |
| Where it runs | Vercel infrastructure. | Cloudflare Containers, behind a Durable Object of your Worker. | The ViteHub process's machine. | Your Linux host, over SSH. |
| Startup | Vercel says milliseconds. | Cloudflare says cold starts are often 1 to 3 seconds. | A local process. | Depends on your host. |
| Limits | Sessions up to 45 minutes on Hobby, 24 hours on Pro. Up to 8 vCPUs and 16 GB memory on Pro. | From 1/16 vCPU and 256 MiB to 4 vCPUs and 12 GiB. Stops after 10 idle minutes by default. | Your machine's. An optional memory cap on Linux. | Your host's. |
| Pricing model | Usage based: active CPU, provisioned memory, creations, and data transfer. Hobby includes a monthly allowance. | Workers Paid plan. Billed per 10 ms of active vCPU, memory, and disk, plus Workers and Durable Objects usage. | Your server's cost. | Crabbox is free. You pay for the host. |
| Select it | `runtime: 'vercel'`, or the `vercel` preset for Sandbox Tasks | `runtime: { kind: 'cloudflare', namespace }`, or the `cloudflare` preset for Sandbox Tasks | `runtime: 'trusted-host'` | `runtime: { kind: 'crabbox', profile }` |

Startup and limit values are vendor claims, not our measurements. Sources: [Vercel Sandbox](https://vercel.com/docs/sandbox), [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing), [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/), [Cloudflare Containers limits](https://developers.cloudflare.com/containers/platform/limits/), [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Cloudflare container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/), and [Crabbox](https://crabbox.sh/).

## Which ViteHub features use each sandbox

| Feature | Runtimes |
| --- | --- |
| [Sandbox Tasks](/docs/sandbox) with `runSandboxTask()` | Vercel Sandbox and Cloudflare Sandbox. |
| [Agent Sandboxes](/docs/agents/sandboxes) for Codex and Claude Code | `trusted-host`, Crabbox, or a custom runtime that forwards process input. |
| `resolveSandbox()` from `vite-hub/sandbox` | All four, or a custom runtime. |

An Agent Sandbox starts the Codex or Claude Code process and sends it input while it runs. Only `trusted-host` and Crabbox forward process input today, so a provider Driver cannot use Vercel Sandbox or Cloudflare Sandbox through the Agent `sandbox` option.

## Vercel Sandbox for AI agents

[Vercel Sandbox](https://vercel.com/docs/sandbox) runs each sandbox in a Firecracker microVM, through the `@vercel/sandbox` SDK. On Vercel, it uses the project environment. Elsewhere, such as Netlify or the Vite dev server, set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. A session ends after 5 minutes unless you set `timeout`; a Sandbox Task uses its Definition timeout.

Select it for Sandbox Tasks with the `vercel` preset:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'vercel', sandboxTask: true },
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
    vitehub({ preset: 'vercel', sandboxTask: true }),
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
  plugins: [
    vitehub({ preset: 'vercel', sandboxTask: true }),
  ],
})
```
:::
::

When your server code owns the commands, install `@vercel/sandbox` and open a session directly. `networkPolicy: 'deny-all'` blocks network access, and ViteHub reports `network: 'none'`:

```ts [server/utils/node-version.ts]
import { resolveSandbox } from 'vite-hub/sandbox'

export async function nodeVersion() {
  const sandbox = await resolveSandbox({
    runtime: { kind: 'vercel', networkPolicy: 'deny-all' },
  }, {})
  console.log(sandbox.plan.executionAuthority.network) // 'none'

  const session = await sandbox.open()
  try {
    const result = await session.exec('node', ['-v'])
    if (!result.ok) throw new Error(result.stderr)
    return result.stdout
  }
  finally {
    await session.close()
  }
}
```

Vercel offers persistent sandboxes, snapshots, custom images, and drives. ViteHub creates each Vercel Sandbox with `persistent: false` and has no options for these. It also starts with the `node24` runtime by default, while Vercel now recommends images over runtimes. For these features, use `@vercel/sandbox` directly.

## Cloudflare Sandbox for AI agents

[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) runs a container on Cloudflare Containers, which your Worker reaches through a Durable Object. ViteHub generates that Durable Object. It starts the Container through the Workers Container API and uses the `Files` class of `@cloudflare/sandbox` 1.x for files. It needs Workers Paid.

Select it for Sandbox Tasks with the `cloudflare` preset:

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'cloudflare', sandboxTask: true },
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
    vitehub({ preset: 'cloudflare', sandboxTask: true }),
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
  plugins: [
    vitehub({ preset: 'cloudflare', sandboxTask: true }),
  ],
})
```
:::
::

The preset writes the Container, the Durable Object binding, the migration, and the Worker exports. If the container has no image, it generates a Dockerfile:

- It builds on `node:24-bookworm-slim` with git, curl, jq, and zip.
- It copies the `sandbox-shim` helper from the `docker.io/cloudflare/sandbox` image whose tag matches your `@cloudflare/sandbox` version.

A custom image must include bash and GNU coreutils (`timeout` on `PATH`), copy `/usr/local/bin/sandbox-shim` from that image, and keep running, such as with `CMD ["sleep", "infinity"]`. The generated container uses the `lite` instance type (1/16 vCPU, 256 MiB) and allows 12 instances. Your own container entry with the same class name keeps its instance type.

Each Sandbox Task run gets a new Sandbox, closed at the end, unless you set `sandboxId` to share one. Cloudflare stops an idle container after 10 minutes by default, which stops billing. The next request gets a fresh container with no earlier state. Change this with `sleepAfter` or `keepAlive` in the [Cloudflare options](/docs/sandbox/hosts#cloudflare-options).

Limits:

- The Vite dev server cannot host the Container. Build, then run `npx wrangler dev --config .output/server/wrangler.json`, which needs Docker.
- There is no network policy option, and ViteHub reports `network: 'unknown'`.
- The generated Durable Object has no preview URLs, so `session.ports` is unavailable. Spawned process output lives in the Durable Object's memory and ends with the Container.

## Self-hosted sandboxes with trusted-host and Crabbox

`trusted-host` runs commands as the ViteHub process's user, on the same machine. Each session gets a private Home and only the declared environment variables. It does not isolate the filesystem, the network, processes, or installed programs.

[Crabbox](https://crabbox.sh/) is an MIT-licensed tool that runs commands on remote machines. ViteHub uses its Static SSH provider to run the same Sandbox declaration on a Linux host. Crabbox needs `cwd` or `checkout`, and keeps the private Home on the target host.

Use these two for Codex and Claude Code Agents:

```ts [server/agents/review/agent.ts]
import { codexDriver, defineAgent } from 'vite-hub/agent'

export default defineAgent({
  sandbox: {
    runtime: 'trusted-host',
    requires: ['git'],
    toolchain: 'project',
  },
  driver: codexDriver(),
})
```

::warning
Neither runtime protects the host from the Agent. Run the Agent only on a host that it may fully control.
::

[Sandboxes](/docs/agents/sandboxes) explains credentials, checkouts, and boot checks.

## Choose a sandbox for AI agents

- Untrusted code: Vercel Sandbox or Cloudflare Sandbox. Never `trusted-host`.
- An app on Cloudflare Workers: Cloudflare Sandbox. The preset generates the bindings, and an idle container stops billing.
- Long jobs or more CPU: Vercel Sandbox. A Pro session runs up to 24 hours with up to 8 vCPUs. The largest Cloudflare instance has 4.
- Limited network access: Vercel Sandbox. ViteHub passes `networkPolicy` and reports the result.
- Codex or Claude Code as the Agent Driver in a Sandbox: `trusted-host` or Crabbox.

## Other AI sandbox platforms

ViteHub has no built-in runtime for E2B, Daytona, Modal, or other platforms. A custom runtime is an object with `name`, `prepare(input)`, and `open(input, options)`, so it can wrap another provider's SDK. See [Bring a custom runtime](https://github.com/vite-hub/vitehub/tree/main/packages/sandbox#bring-a-custom-runtime) in the package README.

## Inspect what a sandbox can reach

Each runtime declares what its commands can reach (`'unknown'` when it cannot prove it). Read it before a Sandbox Task runs:

```ts [server/sandbox-authority.ts]
import { resolveSandboxTaskRunner } from 'vite-hub/sandbox/task'

const runner = await resolveSandboxTaskRunner('release-notes')
console.log(runner.executionAuthority)
```

Read [Sandbox limits and errors](/docs/sandbox/limits-and-errors) before you accept untrusted input, and [Sandbox hosts](/docs/sandbox/hosts) for all provider options.
