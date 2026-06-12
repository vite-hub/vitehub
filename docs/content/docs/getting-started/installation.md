---
title: Installation
description: Add ViteHub packages to your app and register the Vite Integrations you use.
navigation.order: 2
icon: i-lucide-download
---

::code-collapse

```txt [Prompt]
Install ViteHub in my app.

- Choose whether I need server primitives, agents, or both.
- Install only the packages I use.
- Register each installed package in `vite.config.ts`.
- Keep host credentials in environment variables or deployment configuration.
- Start with KV for a small server primitive, or start with Agent definitions for model-backed behavior.
```

::

ViteHub uses feature packages. Install the package that owns the primitive or agent surface you need.

## Prerequisites

- Node 24.
- Vite 8 or newer.
- A server app with a `vite.config.ts` file.
- A package manager such as `pnpm`, `npm`, `yarn`, or `bun`.
- A local `.env` file or deployment environment variable system for host credentials.

## Install a server primitive

Start with one primitive. KV is the smallest first install because it does not require a Definition file.

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

Add more primitives only when your app needs them.

```bash [Terminal]
pnpm add @vite-hub/env @vite-hub/database @vite-hub/blob @vite-hub/queue @vite-hub/workflow @vite-hub/schedule @vite-hub/sandbox @vite-hub/workspace
```

Each package exports its own Vite Integration.

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
Keep the installed set small. The docs show the complete primitive list so you can see the shape, but most apps should start with one or two packages.
::

## Install agents

Install the agent package when you want to define model-backed actors.

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

Agents can use server primitives through capabilities, but the agent package does not automatically expose every primitive to a model. Attach capabilities explicitly in the Agent Definition.

## Verify the installation

Run the development server and call one server route that imports a ViteHub Runtime Helper.

```bash [Terminal]
pnpm dev
```

Confirm the app starts without missing integration errors. If a page imports `kv` but `hubKv()` is missing, ViteHub reports that mismatch during local development.

## Next steps

- Continue with [First server primitive](/docs/getting-started/first-server-primitive) to store and read a KV value.
- Continue with [First agent](/docs/getting-started/first-agent) to define and run an Agent.
- Open [Server primitives](/docs/server-primitives) when you already know which primitive your app needs.
- Open [Agents](/docs/agents) when the main product value is model-backed behavior.
