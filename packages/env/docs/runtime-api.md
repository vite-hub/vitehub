---
title: Env runtime API
description: Reference for Env exports, declaration options, sources, virtual modules, diagnostics, and runtime helpers.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Shared helpers import from `@vitehub/env`:

```ts
import { envSource, envVariable, parseSchema } from '@vitehub/env'
```

::fw{id="vite:dev vite:build"}
Vite config imports from `@vitehub/env/vite`:

```ts
import { envSource, envVariable, envVite } from '@vitehub/env/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module function:

```ts
import { envNitro, envSource, envVariable } from '@vitehub/env/nitro'

export default defineNitroConfig({
  modules: [envNitro()],
})
```

Server code imports the generated helper from `#vitehub/env/server`:

```ts
import { useSafeRuntimeConfig } from '#vitehub/env/server'
```
::

## `envVariable()`

```ts
function envVariable(options?: EnvVariableOptions): EnvVariableDeclaration
```

```ts
interface EnvVariableOptions {
  default?: unknown
  mode?: 'build' | 'runtime'
  optional?: boolean
  required?: boolean
  schema?: unknown
  secret?: boolean
  source?: EnvSource | EnvSourceResolver
  type?: string
}
```

| Option | Default | Description |
| --- | --- | --- |
| `mode` | `runtime` | Declares whether the value resolves at build time or runtime. |
| `required` | `true` | Missing values throw unless a default exists. |
| `optional` | `false` | Makes the value optional. Cannot be combined with `required`. |
| `default` | none | Fallback value used when the source is missing. |
| `schema` | string schema | Sync validator for the resolved value. |
| `secret` | `false` | Masks diagnostics and marks required Cloudflare secrets for Nitro. |
| `source` | inferred env var | Explicit source for the value. |
| `type` | inferred | Type name emitted into generated declaration files. |

## Sources

```ts
envSource.env(name)
envSource.packageJson(path)
envSource.gitBranch()
envSource.gitCommit({ short: true })
envSource.custom(label, resolver)
```

Runtime Nitro registries can serialize `envSource.env()` values. Build-time Vite declarations can also use package, git, and custom sources.

## Vite plugin

```ts
function envVite(options?: EnvIntegrationOptions): EnvVitePlugin
```

```ts
interface EnvIntegrationOptions {
  diagnostics?: 'off' | 'summary' | 'trace'
  prefix?: string
}
```

`envVite()` reads Vite env files with `loadEnv(mode, root, '')`, resolves `env.public` and `env.define`, writes `.vitehub/env/vite.d.ts`, and serves `virtual:@vitehub/env/build`.

## Nitro module

```ts
function envNitro(options?: EnvIntegrationOptions): NitroModule
```

The Nitro module reads nested `env` declarations, writes a runtime registry under `.vitehub/nitro-runtime/env`, installs a Nitro plugin, adds `#vitehub/env/server`, and writes generated Nitro types.

On Cloudflare presets, required secret declarations are appended to `nitro.options.cloudflare.wrangler.secrets.required`.

## Virtual modules

### `virtual:@vitehub/env/build`

```ts
export const buildConfig: {
  public: Record<string, unknown>
}

export function useSafeBuildConfig(): typeof buildConfig
export default buildConfig
```

### `#vitehub/env/server`

```ts
export interface SafeRuntimeConfig {}

export function useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig
```

The exact `SafeRuntimeConfig` fields are generated from Nitro `env` declarations.

## Validation

`parseSchema(schema, value, label)` supports:

- Standard Schema-compatible sync validators
- zod-like `safeParse()`
- zod-like `parse()`

Async schemas throw because Env validation currently requires sync schemas.
