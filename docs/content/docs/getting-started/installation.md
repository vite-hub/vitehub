---
title: Installation
description: Install one ViteHub package or register the full Vite preset.
navigation.order: 2
icon: i-lucide-download
---

ViteHub packages are composable. Install the package that owns your first
feature, or use the preset when you want to explore several primitives in one
application.

## Prerequisites

- Node.js 24 or newer.
- Vite 8 or newer.
- An ESM package with `"type": "module"` or a `vite.config.mts` file.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.

Model providers and hosted primitives may require credentials. Each feature
guide lists its own environment, network, and billing prerequisites before the
first call.

## Install one package

Direct packages keep the first integration small. The quickstarts install
their HTTP server and Vite dependencies explicitly so every boundary remains
reproducible.

| Path | Install | Continue |
| --- | --- | --- |
| Server Primitives | `pnpm add @vite-hub/kv h3 vite` | [First Server Primitive](/docs/getting-started/first-server-primitive) |
| Agents | `pnpm add @vite-hub/agent h3 vite` | [First Agent](/docs/getting-started/first-agent) |

Other feature pages provide the matching package and Vite Integration. For
example, Blob uses `@vite-hub/blob` with `hubBlob()`, while Queue uses
`@vite-hub/queue` with `hubQueue()`.

## Use the preset

Install `@vite-hub/vite` when one application needs several ViteHub packages
and you prefer one integration entry point.

```bash [Terminal]
pnpm add @vite-hub/vite vite
```

Register the preset in Vite.

```ts [vite.config.ts]
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub(),
  ],
})
```

The preset composes package integrations. Product code still imports Runtime
Helpers from the package that owns the feature.

::tip
Prefer a direct package for the first proof. Add the preset when it removes
real integration repetition from an application that uses several packages.
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
