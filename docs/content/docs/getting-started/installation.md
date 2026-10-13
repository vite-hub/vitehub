---
title: Installation
navigation.title: Installation
description: Install the ViteHub framework distribution, select a deployment preset, or choose a direct owner package for advanced composition.
navigation.order: 2
icon: i-lucide-download
---

Use this page to add ViteHub to an existing Vite or Nuxt application. Install
`vite-hub` when you build an application. It provides the Vite integration, the
Nuxt module, the CLI, and every public feature import through one dependency.

## Prerequisites

- Node.js 24.15 or newer.
- Vite 8 or newer.
- An ESM package with `"type": "module"` or a `vite.config.mts` file.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.

Model providers and hosted primitives may require credentials. Each feature
guide lists its own environment, network, and billing prerequisites before the
first call.

## Install the framework distribution

Add `vite-hub` and Nitro to an existing Vite application. Nitro builds the server
output for the selected host.

```bash [Terminal]
pnpm add vite-hub nitro
```

Register `vitehub()` and Nitro's Vite plugin.

```ts [vite.config.ts]
import { nitro } from "nitro/vite"
import { defineConfig } from "vite"
import { vitehub } from "vite-hub"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node" }),
    // SAFETY: Nitro's Vite plugin is runtime-compatible with this Vite version despite its prerelease type identity.
    nitro() as never,
  ],
})
```

## Select a deployment preset

`preset` is required. Use `node`, `cloudflare`, `vercel`, `netlify`, or `deno`.
The preset selects the host, the Nitro preset, and the default provider for each
enabled feature. Start with `node` for local work, then change the preset when
you deploy. [Frameworks and hosts](/docs/frameworks-hosts#choose-a-preset) lists
the output and default providers for each preset.

## Enable features

Each feature is off until you enable it in `vitehub()`, for example
`vitehub({ preset: "node", kv: true })`. Env is on unless you set `env: false`.
Workflow turns on with `agent` unless you set `workflow: false`. A feature that
the preset cannot provide fails the build instead of falling back to another
provider.

Import application APIs from explicit feature subpaths.

```ts [server/agents/support.ts]
import { defineAgent } from "vite-hub/agent"
import { access } from "vite-hub/agent/capabilities"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkspace } from "vite-hub/workspace"

void defineAgent
void access
void requireRateLimit
void defineWorkspace
```

## Install in Nuxt

In Nuxt, register the framework module instead of `vitehub()` and `nitro()`.
Nuxt provides its own Nitro integration, so do not install `nitro` separately.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
```

The [Nuxt guide](/docs/frameworks-hosts/nuxt) lists the differences from the
Vite integration.

## Add coding provider packages

Install third-party model providers and chat adapters separately. Built-in coding
providers use the provider runtime pinned by ViteHub, but ViteHub does not install
their large native binaries. Add `@openai/codex@0.149.1` for Codex or
`@anthropic-ai/claude-agent-sdk@0.3.246` for Claude Code.

Self-hosted Node builds on macOS and Linux package only the build host's OS, CPU,
and Linux libc payload. Build on the same host type as the deployment host.

Until T3 publishes the provider runtime on npm, pnpm consumers using a built-in
coding provider must set `blockExoticSubdeps: false` in `pnpm-workspace.yaml`.
ViteHub pins an exact pkg.pr.new tarball rather than a moving branch.

The distribution includes the Workflow DevKit runtime and builders for Vercel
Workflow. Install other provider SDKs only when you use them.

## Install an owner package directly

Every `@vite-hub/*` package can also be installed on its own. Use a package
directly when you build a library or need to configure one integration
without the framework distribution.

| Path | Direct install | Integration |
| --- | --- | --- |
| Server Primitives | `pnpm add @vite-hub/kv vite` | `hubKv()` from `@vite-hub/kv/vite` |
| Rate Limit | `pnpm add @vite-hub/rate-limit vite` | `hubRateLimit()` from `@vite-hub/rate-limit/vite` |
| Agents | `pnpm add @vite-hub/agent vite` | `hubAgent()` from `@vite-hub/agent/vite` |

::tip
Start new applications with `vite-hub`. Direct owner packages are the
escape hatch when package-level control is the goal.
::

## Add generated types

Vite integrations write types under `.vitehub/types`. Include that directory when
your application uses generated names or stable `#vitehub/...` imports. The Nuxt
module adds these types to the Nuxt TypeScript config for you.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Verify the integration

Run the application with its Vite-based development command. If a server API
is missing its Vite integration, ViteHub reports the configuration error instead
of selecting another provider.

The two first-success guides include complete build and runtime commands:

- [First Server Primitive](/docs/getting-started/first-server-primitive) stores and reads a KV value without credentials.
- [First Agent](/docs/getting-started/first-agent) runs a deterministic Agent Invocation without a model key.

## Next steps

- Read [Vite Integrations and Provider Output](/docs/development/integrations-and-output) to understand integration ownership.
- Open [Server Primitives](/docs/getting-started/server-primitives) to choose infrastructure.
- Open [Agents](/docs/agents) to choose an Agent Driver and Capabilities.
