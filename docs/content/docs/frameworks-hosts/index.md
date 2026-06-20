---
title: Vite
description: Use Vite Integrations to discover ViteHub Definitions and generate host output without making app code host-specific.
navigation.title: Vite
navigation.order: 40
icon: i-simple-icons-vite
---

Vite is the public framework integration layer for ViteHub.
Vite Integrations discover Definitions, generate Runtime Registries, expose Stable ViteHub Import Paths, and write Provider Output when a package needs host artifacts.

## What Vite owns

| Vite Integration responsibility | Boundary |
| --- | --- |
| Discover Definitions | File conventions produce Discovered Definitions and Discovery Identity. |
| Generate Runtime Registries | App code uses Stable ViteHub Import Paths instead of generated files. |
| Resolve Integration Options | Provider Selection and build-time options become Runtime Config or Provider Output. |
| Register DevTools Features | Package integrations register DevTools Features and DevTools Bridges. |
| Write Provider Output | Packages generate host artifacts during production-shaped builds. |

## Add package integrations

Install only the packages your app uses.
Each package integration owns its primitive, Capability, or Agent surface.

```ts [vite.config.ts]
import { hubAgent } from '@vite-hub/agent/vite'
import { hubDevtools } from '@vite-hub/devtools'
import { hubEnv } from '@vite-hub/env/vite'
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    hubDevtools(),
    hubEnv(),
    hubKv(),
    hubAgent(),
  ],
})
```

## Keep runtime imports stable

Application code should import Runtime Helpers and generated surfaces through ViteHub-owned import paths.
Do not import framework virtual modules or generated files unless a package reference marks that path public.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

## Inspect Vite output

Vite dev proves discovery and generated local files.
Production-shaped builds prove Provider Output.

```bash [Terminal]
pnpm dev
find .vitehub -maxdepth 4 -type f | sort
pnpm build
```

## Next steps

- Use [File conventions](/docs/reference/file-conventions) for discovery paths.
- Use [Provider output](/docs/reference/provider-output) for generated host artifacts.
- Use [Local development](/docs/development) for proof paths.
