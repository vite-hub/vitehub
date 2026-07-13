# @vite-hub/vite

`@vite-hub/vite` is the application package for ViteHub. It provides one install, the `vitehub()` Vite preset, the `vitehub` CLI, and stable facade imports for ViteHub-owned application APIs.

Use the preset when an application needs several ViteHub integrations and does not need to register each `hubX()` plugin separately.

## Install

Add the preset to an existing Vite application:

```sh
pnpm add @vite-hub/vite
```

## Configure Vite

Add `vitehub()` to the Vite plugin list.

```ts
// vite.config.ts
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [vitehub()],
})
```

The preset composes these integrations by default:

- Agent
- Blob
- Database
- DevTools
- Env
- KV
- Sandbox
- Schedule
- Workflow
- Workspace

Auth is not part of the preset. Register `hubAuth()` from `@vite-hub/auth/vite` explicitly when the application has an Auth Definition. Runtime, Shell, and Source are libraries rather than preset Vite integrations.

Pass `false` for an integration that the application does not use.

```ts
// vite.config.ts
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({
      agent: false,
      sandbox: false,
      workflow: false,
    }),
  ],
})
```

Queue is opt-in because enabling it selects hosted Queue Provider Output. Pass `queue: true` to use provider inference, or pass Queue integration options explicitly. Netlify does not infer a Queue provider.

```ts
// vite.config.ts
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({
      queue: true,
    }),
  ],
})
```

## Application imports

Applications using the preset import ViteHub APIs through its feature subpaths. The feature name remains visible without requiring a separate package dependency.

```ts
import { defineAgent } from "@vite-hub/vite/agent"
import { access } from "@vite-hub/vite/agent/capabilities"
import { defineWorkspace } from "@vite-hub/vite/workspace"
```

The root entry also exports the Env declaration helper used by Vite config.

```ts
import { env, vitehub } from "@vite-hub/vite"
```

Third-party choices remain explicit dependencies. Install the model provider, chat adapter, database driver, or harness that the application selects.

Individual ViteHub packages remain available for libraries and focused applications that do not use the preset:

```ts
// vite.config.ts
import { hubKv } from "@vite-hub/kv/vite"
```

The facade does not change package defaults. Each feature still resolves its own provider, generated output, runtime environment, and validation rules.

## Reference

- [ViteHub configuration reference](https://vitehub.dev/docs/reference/config-options)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)
