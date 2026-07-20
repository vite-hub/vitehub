---
title: Installation
description: Install the ViteHub framework distribution or choose a direct owner package for advanced composition.
navigation.order: 2
icon: i-lucide-download
---

Install `vite-hub` for the normal application path. It provides the main Vite
Integration and intentional feature subpaths while keeping one direct ViteHub
dependency in the application manifest.

## Prerequisites

- Node.js 24 or newer.
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

Import application APIs from explicit feature subpaths.

```ts [server/agents/support.ts]
import { defineAgent } from "vite-hub/agent"
import { access } from "vite-hub/agent/capabilities"
import { requireRateLimit } from "vite-hub/rate-limit"
import { defineWorkspace } from "vite-hub/workspace"
```

Model providers, chat adapters, and harness adapters remain explicit
dependencies because the application chooses them. The distribution includes
the Workflow DevKit runtime and builders because Vercel Workflow is a deliberate
framework default; other provider SDKs stay package-owned and explicit.

## Install an owner package directly

Every `@vite-hub/*` owner package remains independently installable. Use one
directly for a library, a focused integration, or an advanced composition that
does not want the framework distribution.

| Path | Direct install | Integration |
| --- | --- | --- |
| Server Primitives | `pnpm add @vite-hub/kv vite` | `hubKv()` from `@vite-hub/kv/vite` |
| Rate Limit | `pnpm add @vite-hub/rate-limit vite` | `hubRateLimit()` from `@vite-hub/rate-limit/vite` |
| Agents | `pnpm add @vite-hub/agent vite` | `hubAgent()` from `@vite-hub/agent/vite` |

::tip
New applications should start with `vite-hub`. Direct owner packages are the
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

Run the application through its Vite-based development command. A Runtime
Helper without its matching Vite Integration should fail visibly instead of
silently choosing an unrelated provider.

The two first-success guides include complete build and runtime commands:

- [First Server Primitive](/docs/getting-started/first-server-primitive) stores and reads a KV value without credentials.
- [First Agent](/docs/getting-started/first-agent) runs a deterministic Agent Invocation without a model key.

## Next steps

- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) to understand integration ownership.
- Open [Server Primitives](/docs/server-primitives) to choose infrastructure.
- Open [Agents](/docs/agents) to choose an Agent Driver and Capabilities.
- Read [Migrate to `vite-hub`](/docs/getting-started/migration) for existing applications.
