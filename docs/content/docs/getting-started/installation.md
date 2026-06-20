---
title: Installation
description: Add ViteHub packages to your app and register the Vite Integrations or preset you use.
navigation.order: 2
icon: i-lucide-download
---

::code-collapse

```txt [Prompt]
Install ViteHub in my app.

- Choose whether I need server primitives, agents, or both.
- Install the common ViteHub preset or only the packages I use.
- Register the preset or package-owned integrations in `vite.config.ts`.
- Keep host credentials in environment variables or deployment configuration.
- Start with KV for a small server primitive, or start with Agent definitions for model-backed behavior.
```

::

ViteHub installs as package-owned server primitives and agent packages. Add only the packages your app uses, then register each package's Vite Integration in `vite.config.ts`.

## Prerequisites

- Node 24 or newer.
- Vite 8 or newer.
- A server app with a `vite.config.ts` file.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.
- A local `.env` file or provider environment variable system for host credentials.

## Install one primitive

KV is the smallest first server primitive because it gives ordinary server code one stable Runtime Helper and does not require a Definition file.

```bash [Terminal]
pnpm add @vite-hub/kv
```

Register the integration in `vite.config.ts`.

```ts [vite.config.ts]
import { hubKv } from "@vite-hub/kv/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubKv()],
});
```

Install more primitives only when the app needs them.

```bash [Terminal]
pnpm add @vite-hub/env @vite-hub/database @vite-hub/blob @vite-hub/queue @vite-hub/workflow @vite-hub/schedule @vite-hub/sandbox @vite-hub/workspace
```

Each package owns its Vite Integration. Register the integrations for the packages you installed.

```ts [vite.config.ts]
import { hubBlob } from "@vite-hub/blob/vite";
import { hubDb } from "@vite-hub/database/vite";
import { hubEnv } from "@vite-hub/env/vite";
import { hubKv } from "@vite-hub/kv/vite";
import { hubQueue } from "@vite-hub/queue/vite";
import { hubSandbox } from "@vite-hub/sandbox/vite";
import { hubSchedule } from "@vite-hub/schedule/vite";
import { hubWorkflow } from "@vite-hub/workflow/vite";
import { hubWorkspace } from "@vite-hub/workspace/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    hubEnv(),
    hubKv(),
    hubDb(),
    hubBlob(),
    hubQueue(),
    hubWorkflow(),
    hubSchedule(),
    hubSandbox(),
    hubWorkspace(),
  ],
});
```

::tip
Keep the installed set small. Most apps should start with one or two primitives, then add more when a page or feature needs them.
::

## Install the common ViteHub preset

Use the ViteHub preset when the app needs the common agent runtime surface and you do not want to wire each package-owned Vite Integration by hand.

```bash [Terminal]
pnpm add @vite-hub/vite @ai-sdk/gateway
```

Register the preset as one Vite plugin entry.

```ts [vite.config.ts]
import { vitehub } from "@vite-hub/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    vitehub(),
  ],
});
```

Disable package integrations the app does not use.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [
    vitehub({
      database: false,
      workflow: false,
    }),
  ],
});
```

## Install agents

Install the Agent Package when the app needs Agent Definitions and Agent Invocations.

```bash [Terminal]
pnpm add @vite-hub/agent @ai-sdk/gateway
```

Register the Agent integration.

```ts [vite.config.ts]
import { hubAgent } from "@vite-hub/agent/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [hubAgent()],
});
```

Agents can use server primitives through Capabilities, but installing `@vite-hub/agent` does not expose every primitive to a model. Attach Capabilities explicitly in each Agent Definition.

## Add generated types

Some packages write generated types under `.vitehub/types`. Add that directory to `tsconfig.json` when a feature page tells you to use generated names or stable `#vitehub/...` imports.

```json [tsconfig.json]
{
  "include": [
    "server/**/*.ts",
    "src/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Verify the installation

Run the development server and call one server route that imports a ViteHub Runtime Helper.

```bash [Terminal]
pnpm dev
```

Confirm the app starts without missing integration errors. If server code imports a package Runtime Helper but the matching Vite Integration is missing, local development should report the mismatch before deployment.

## Next steps

- Continue with [First server primitive](/docs/getting-started/first-server-primitive) to store and read a KV value.
- Continue with [First agent](/docs/getting-started/first-agent) to define and run an Agent.
- Read [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) to understand what the integration owns.
