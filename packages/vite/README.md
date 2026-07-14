# @vite-hub/vite

`@vite-hub/vite` is the composition preset for package-owned ViteHub integrations. It provides one `vitehub()` plugin entry while each ViteHub package continues to own its configuration, Runtime Helpers, generated files, and Provider Output.

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
- Workflow
- Workspace

Auth is not part of the preset. Register `hubAuth()` from `@vite-hub/auth/vite` explicitly when the application has an Auth Definition. Runtime, Shell, and Source are libraries rather than preset Vite integrations.

Pass `false` to disable one of the default integrations.

```ts
// vite.config.ts
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({
      agent: false,
      workflow: false,
    }),
  ],
})
```

KV, Queue, Sandbox, and Schedule are opt-in. Pass `true` to enable one with inferred defaults, or pass its integration options explicitly. Netlify does not infer a Queue provider.

```ts
// vite.config.ts
import { vitehub } from "@vite-hub/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [
    vitehub({
      kv: true,
      queue: true,
      sandbox: true,
      schedule: true,
    }),
  ],
})
```

## Public import boundary

`@vite-hub/vite` exports `vitehub()` and the `ViteHubPresetOptions` type. It does not re-export Runtime Helpers, Definition helpers, Capabilities, or package-specific integration functions.

Import application APIs from the package that owns them:

```ts
// server/settings.ts
import { kv } from "@vite-hub/kv"
```

Import an individual integration directly when the application does not use the preset:

```ts
// vite.config.ts
import { hubKv } from "@vite-hub/kv/vite"
```

The preset does not change package defaults. Each package still resolves its own provider, generated output, runtime environment, and validation rules.

## Reference

- [ViteHub configuration reference](https://vitehub.dev/docs/reference/config-options)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)
