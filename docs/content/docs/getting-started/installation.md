---
title: Installation
description: Install the ViteHub framework distribution or choose a direct owner package for advanced composition.
navigation.order: 2
icon: i-lucide-download
---

Install `vite-hub` when you are building an application. It provides the Vite
integration and public feature imports through one dependency.

## Prerequisites

- Node.js 24.15 or newer.
- Vite 8 or newer.
- An ESM package with `"type": "module"` or a `vite.config.mts` file.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.

Model providers and hosted primitives may require credentials. Each feature
guide lists its own environment, network, and billing prerequisites before the
first call.

## Install the framework distribution

Add `vite-hub` to an existing Vite application.

```bash [Terminal]
pnpm add vite-hub
```

Register the framework integration in Vite.

```ts [vite.config.ts]
import { vitehub } from "vite-hub"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({ preset: "node" }),
  ],
})
```

In Nuxt, register the framework module. It installs the same Vite integrations
and carries their Nitro configuration through Nuxt's lifecycle.

```ts [nuxt.config.ts]
import viteHubNuxt from "vite-hub/nuxt"

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, { preset: "node" }],
  ],
})
```

Import application APIs from explicit feature subpaths.

```ts [server/agents/support.ts]
import { defineAgent } from "vite-hub/agent"
import { access } from "vite-hub/agent/capabilities"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkspace } from "vite-hub/workspace"
```

Install third-party model providers and chat adapters separately. Built-in coding
providers use the provider runtime pinned by ViteHub. The distribution includes
the Workflow DevKit runtime and builders for Vercel Workflow; install other
provider SDKs only when you use them.

Until T3 publishes the provider runtime on npm, pnpm consumers using a built-in coding provider must set `blockExoticSubdeps: false` in `pnpm-workspace.yaml`; ViteHub pins an exact pkg.pr.new tarball rather than a moving branch.

## Install an owner package directly

Every `@vite-hub/*` package can also be installed on its own. Use a package
directly when you are building a library or need to configure one integration
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

Some packages write types under `.vitehub/types`. Include that directory when
your application uses generated names or stable `#vitehub/...` imports.

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

- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) to understand integration ownership.
- Open [Server Primitives](/docs/server-primitives) to choose infrastructure.
- Open [Agents](/docs/agents) to choose an Agent Driver and Capabilities.
