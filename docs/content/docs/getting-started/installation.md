---
title: Installation
description: Install the ViteHub preset, register its Vite Integration, and verify the app boots.
navigation.order: 2
icon: i-lucide-download
---

::code-collapse

```txt [Prompt]
Install ViteHub in my app.

- Start with the ViteHub preset.
- Install direct primitive or provider packages only when a page asks for them.
- Register the preset Vite Integration in `vite.config.ts`.
- Add generated ViteHub types to `tsconfig.json`.
- Verify local development starts without missing integration errors.
```

::

ViteHub starts with the `@vite-hub/vite` preset. Add direct primitive, Agent Package, or provider packages only when a guide needs a narrower install.

## Prerequisites

- Node 24 or newer.
- Vite 8 or newer.
- A server app with an ESM Vite config, such as `vite.config.ts` in a `"type": "module"` package or `vite.config.mts`.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.
- A local `.env` file or provider environment variable system for host credentials.

::steps{level="2"}

## Install the preset

Install `@vite-hub/vite` for the default ViteHub setup.

```bash [Terminal]
pnpm add @vite-hub/vite
```

Model-backed agent guides may ask you to install `@vite-hub/agent` and a model provider such as `@ai-sdk/gateway` directly. Use those page-specific installs when you are following that narrower path.

::tip
Install only the packages you use. Add Env, Database, Blob, Queue, Workflow, Schedule, Sandbox, Workspace, Agent, or provider packages when a page or feature needs them.
::

## Register the Vite Integration

Register the preset Vite Integration with `vitehub()` in `vite.config.ts`. ViteHub packages are ESM-only, so fresh npm projects should either set `"type": "module"` in `package.json` or name the config `vite.config.mts`.

```ts [vite.config.ts]
import { vitehub } from "@vite-hub/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vitehub(),
  ],
});
```

## Add generated types

Some packages write generated types under `.vitehub/types`. Add that directory to `tsconfig.json` before using generated names or stable `#vitehub/...` imports.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Verify local development

Run the development server.

```bash [Terminal]
pnpm dev
```

Confirm the app starts without missing integration errors. If server code imports a ViteHub Runtime Helper but the matching Vite Integration is missing, local development should report the mismatch before deployment.

::

## Next steps

- Continue with [First server primitive](/docs/getting-started/first-server-primitive) to store and read a KV value.
- Continue with [First agent](/docs/getting-started/first-agent) to define and run an Agent.
- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) to understand what the integration owns.
