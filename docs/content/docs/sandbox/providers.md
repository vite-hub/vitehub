---
title: AI sandbox providers compared
description: Compare Vercel Sandbox, Cloudflare Sandbox, and self-hosted runtimes as an AI agent sandbox. See isolation, limits, pricing, and the ViteHub setup for each.
seo.title: Vercel Sandbox vs Cloudflare Sandbox for AI agents
navigation.title: Compare providers
navigation.order: 8.5
icon: i-lucide-scale
---

An AI sandbox runs code that a model or a user wrote, away from your server and its secrets. ViteHub has four built-in Sandbox runtimes. Vercel Sandbox and Cloudflare Sandbox isolate the code in the cloud. `trusted-host` and Crabbox run it on a machine that you own, without isolation.

This page compares the four runtimes and tells you which ViteHub features use each one. The vendor facts come from the vendor docs on 2026-10-29. Limits and prices change, so check the linked vendor pages before you decide.

::agent-only
Select the Sandbox runtime explicitly. Do not use `trusted-host` or Crabbox for untrusted code.

Before you rely on isolation, read `sandbox.plan.executionAuthority`, or `executionAuthority` from `resolveSandboxTaskRunner(name)`. Take vendor limits and prices from the linked vendor pages, not from this page.

Prove one successful run, one timeout, and cleanup on the selected runtime.
::

## What is an AI agent sandbox

An agent sandbox is an execution environment for commands that an agent decides to run. The agent can install packages, run tests, or execute generated code there. The sandbox decides which files, network destinations, and credentials those commands can reach.

A sandbox does not decide what the agent may do. Approvals, tool policy, and Capabilities do that. The sandbox limits the damage when a command does something wrong.

## Compare sandbox providers

| | Vercel Sandbox | Cloudflare Sandbox | `trusted-host` | Crabbox |
| --- | --- | --- | --- | --- |
| Isolation | A Firecracker microVM with its own filesystem and network. | A container. Cloudflare runs each instance as a microVM with its own kernel and network. | None. Only the Home and the environment are private. | None on the target host. |
| ViteHub reports | `isolation: 'microvm'` | `isolation: 'container'` | `isolation: 'none'` | `isolation: 'none'` |
| Where it runs | Vercel infrastructure. | Cloudflare Containers, behind a Durable Object of your Worker. | The machine of the ViteHub process. | A Linux host that you own, over SSH. |
| Startup | Vercel states that sandboxes start in milliseconds. | Cloudflare states that cold starts are often 1 to 3 seconds. | A local process. | Depends on your host. |
| Limits | Sessions up to 45 minutes on Hobby and 24 hours on Pro. Up to 8 vCPUs and 16 GB of memory on Pro. | Instance types from 1/16 vCPU and 256 MiB to 4 vCPUs and 12 GiB. The container stops after 10 idle minutes by default. | The limits of your machine. An optional memory cap on Linux. | The limits of your host. |
| Pricing model | Usage based. Active CPU, provisioned memory, creations, and data transfer. Hobby includes a monthly allowance. | Workers Paid plan. Billed for each 10 ms of active vCPU, memory, and disk, plus Workers and Durable Objects usage. | The cost of your server. | Crabbox is free. You pay for the host. |
| Select it | `runtime: 'vercel'`, or the `vercel` preset for Sandbox Tasks | `runtime: { kind: 'cloudflare', namespace }`, or the `cloudflare` preset for Sandbox Tasks | `runtime: 'trusted-host'` | `runtime: { kind: 'crabbox', profile }` |

The startup and limit values are vendor statements, not ViteHub measurements. Sources: [Vercel Sandbox](https://vercel.com/docs/sandbox), [Vercel Sandbox pricing and quotas](https://vercel.com/docs/sandbox/pricing), [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/), [Cloudflare Containers limits](https://developers.cloudflare.com/containers/platform/limits/), [Cloudflare Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/), [Cloudflare container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/), and [Crabbox](https://crabbox.sh/).

## Which ViteHub features use each sandbox

| Feature | Runtimes |
| --- | --- |
| [Sandbox Tasks](/docs/sandbox) with `runSandboxTask()` | Vercel Sandbox and Cloudflare Sandbox. |
| [Agent Sandboxes](/docs/agents/sandboxes) for Codex and Claude Code | `trusted-host`, Crabbox, or a custom runtime that forwards process input. |
| `resolveSandbox()` from `vite-hub/sandbox` | All four, or a custom runtime. |

An Agent Sandbox starts the Codex or Claude Code process and sends it input while it runs. Only `trusted-host` and Crabbox forward process input today. That is why a provider Driver cannot run in Vercel Sandbox or Cloudflare Sandbox through the Agent `sandbox` option.

## Vercel Sandbox for AI agents

[Vercel Sandbox](https://vercel.com/docs/sandbox) runs each sandbox in a Firecracker microVM. ViteHub uses the `@vercel/sandbox` SDK. On Vercel, it uses the project environment. It also works outside Vercel, for example on Netlify or the Vite dev server, when you set `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, and `VERCEL_PROJECT_ID`. A session ends after 5 minutes unless you set `timeout`. A Sandbox Task uses its Definition timeout instead.

Select it for Sandbox Tasks with the `vercel` preset:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'vercel', sandboxTask: true }),
  ],
})
```

Open a session directly when your server code owns the commands. Install `@vercel/sandbox` first. `networkPolicy: 'deny-all'` blocks network access, and ViteHub then reports `network: 'none'`:

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

Vercel does more than ViteHub exposes. Vercel offers persistent sandboxes, snapshots, custom images, and drives. ViteHub creates each Vercel Sandbox with `persistent: false` and has no options for these features. ViteHub also starts the Sandbox with the `node24` runtime by default, and Vercel now recommends images over runtimes. Use `@vercel/sandbox` directly when you need these features.

## Cloudflare Sandbox for AI agents

[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) runs a container on Cloudflare Containers. Your Worker reaches it through a Durable Object. ViteHub uses the `@cloudflare/sandbox` SDK, and you need the Workers Paid plan.

Select it for Sandbox Tasks with the `cloudflare` preset:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ preset: 'cloudflare', sandboxTask: true }),
  ],
})
```

The preset writes the Container, the Durable Object binding, the migration, and the Worker exports. It generates a Dockerfile when the container has no image. The generated container uses the `lite` instance type, which has 1/16 vCPU and 256 MiB of memory, and allows 12 instances. An application-owned container entry with the same class name keeps its own instance type.

ViteHub creates and closes a new Sandbox for each Sandbox Task run, unless you set `sandboxId` to share one. Cloudflare stops an idle container after 10 minutes by default. The next request starts a fresh container, and the earlier state is gone. Charges stop while the container sleeps. Set `sleepAfter` or `keepAlive` in the [Cloudflare options](/docs/sandbox/hosts#cloudflare-options) to change this.

Plan for these limits:

- The Vite dev server cannot host the Container. Build the app, then run `npx wrangler --cwd .output/server dev`. Wrangler needs Docker for this.
- ViteHub has no network policy option for Cloudflare Sandbox, and it reports `network: 'unknown'`.

## Self-hosted sandboxes with trusted-host and Crabbox

`trusted-host` runs commands as the user of the ViteHub process, on the same machine. Each session gets a private Home and only the declared environment variables. It does not isolate the filesystem, the network, processes, or installed executables. On Linux, `runtime.resources` puts all commands of a session in one cgroup v2 group with a memory limit.

[Crabbox](https://crabbox.sh/) is an MIT-licensed tool that runs commands on remote machines. ViteHub uses its Static SSH provider to run the same Sandbox declaration on a Linux host. Crabbox needs `cwd` or `checkout`, and it keeps the private Home on the target host.

Use these two runtimes for Codex and Claude Code Agents:

```ts [server/agents/review/agent.ts]
import { defineAgent } from 'vite-hub/agent'

export default defineAgent({
  sandbox: {
    runtime: 'trusted-host',
    requires: ['git'],
    toolchain: 'project',
  },
  driver: { kind: 'codex' },
})
```

Neither runtime protects the host from the Agent. Run the Agent only on a host that it may control completely. [Sandboxes](/docs/agents/sandboxes) explains credentials, checkouts, and boot checks.

## Choose a sandbox for AI agents

- For code that you do not trust, use Vercel Sandbox or Cloudflare Sandbox. Never use `trusted-host` for it.
- For an app that runs on Cloudflare Workers, use Cloudflare Sandbox. The preset generates the bindings, and an idle container stops billing.
- For long jobs or more CPU, use Vercel Sandbox. A Pro session runs up to 24 hours with up to 8 vCPUs. The largest Cloudflare instance type has 4 vCPUs.
- To limit network access, use Vercel Sandbox. ViteHub passes `networkPolicy` and reports the result.
- To run Codex or Claude Code as the Agent Driver in a Sandbox, use `trusted-host` or Crabbox.

## Other AI sandbox platforms

ViteHub has no built-in runtime for other sandbox platforms, such as E2B, Daytona, or Modal. A custom runtime is an object with `name`, `prepare(input)`, and `open(input, options)`, so it can wrap the SDK of another provider. Read [Bring a custom runtime](https://github.com/vite-hub/vitehub/tree/main/packages/sandbox#bring-a-custom-runtime) in the package README.

## Inspect what a sandbox can reach

Each runtime declares what its commands can reach. A value that the runtime cannot prove is `'unknown'`. Read it before you run a Sandbox Task:

```ts [server/sandbox-authority.ts]
import { resolveSandboxTaskRunner } from 'vite-hub/sandbox/task'

const runner = await resolveSandboxTaskRunner('release-notes')
console.log(runner.executionAuthority)
```

Read [Sandbox limits and errors](/docs/sandbox/limits-and-errors) before you accept untrusted input, and [Sandbox hosts](/docs/sandbox/hosts) for every provider option.
