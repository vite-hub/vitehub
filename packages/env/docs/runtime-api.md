---
title: Env runtime API
description: Reference for Env exports, declaration options, sources, generated import paths, diagnostics, and runtime helpers.
navigation.title: Runtime API
navigation.order: 90
icon: i-lucide-braces
frameworks: [vite, nitro]
---

Use this page when you need exact names and option fields. For a guided setup, start with [Quickstart](./quickstart).

## Imports

Shared helpers import from `@vitehub/env`:

```ts
import { env, parseSchema } from '@vitehub/env'
```

::fw{id="vite:dev vite:build"}
Vite config imports from `@vitehub/env/vite`:

```ts
import { env, envVite } from '@vitehub/env/vite'
```
::

::fw{id="nitro:dev nitro:build"}
Nitro config registers the module function:

```ts
import { env, envNitro } from '@vitehub/env/nitro'

export default defineNitroConfig({
  modules: [envNitro()],
})
```

Server code imports the generated helper from `#vitehub/env/server`:

```ts
import { useServerEnv } from '#vitehub/env/server'
```

Browser-safe code imports the generated helper from `#vitehub/env/public`:

```ts
import { usePublicEnv } from '#vitehub/env/public'
```
::

## `env()`

```ts
const env: {
  (options?: EnvVariableOptions): EnvVariableDeclaration
  variable(options?: EnvVariableOptions): EnvVariableDeclaration
}
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
| `secret` | `false` | Masks diagnostics, marks required Cloudflare secrets for Nitro, and resolves runtime values as `SecretEnv`. |
| `source` | inferred env var | Explicit source for the value. |
| `type` | inferred | Type name emitted into generated declaration files. |

## Sources

```ts
env.source(name)
env.packageJson(path)
env.gitBranch()
env.gitCommit({ short: true })
env.custom(label, resolver)
```

Runtime Nitro registries can serialize `env.source()` values. Build-time Vite declarations can also use package, git, and custom sources.

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

`envVite()` reads Vite env files with `loadEnv(mode, root, '')`, resolves `env.public` and `env.define`, writes `.vitehub/env/vite.d.ts`, and serves `#vitehub/env/public`.

## Nitro module

```ts
function envNitro(options?: EnvIntegrationOptions): NitroModule
```

The Nitro module reads nested `env` declarations, writes a runtime registry under `.vitehub/nitro-runtime/env`, installs a Nitro plugin, adds `#vitehub/env/server`, and writes generated Nitro types.

On Cloudflare presets, required secret declarations are appended to `nitro.options.cloudflare.wrangler.secrets.required`.

## Generated import paths

### `#vitehub/env/public`

```ts
export interface PublicEnv {}

export const publicEnv: PublicEnv
export function usePublicEnv(): PublicEnv
```

### `#vitehub/env/server`

```ts
export class SecretEnv<T = string> {
  constructor(value: T)
  unseal(): T
  toString(): string
  toJSON(): string
  [Symbol.toPrimitive](): string
}

export interface ServerEnv {}

export function useServerEnv(event?: unknown): ServerEnv
```

The exact `ServerEnv` fields are generated from Nitro `env` declarations.

Runtime declarations with `secret: true` generate `SecretEnv<string>` fields. Optional missing secrets stay `undefined`; present secrets must be unsealed explicitly:

```ts
const config = useServerEnv(event)
const token = config.auth.token.unseal()
```

`SecretEnv` redacts through `String(secret)`, template literals, `JSON.stringify()`, and Node inspect output.

## Validation

`parseSchema(schema, value, label)` supports:

- Standard Schema-compatible sync validators
- zod-like `safeParse()`
- zod-like `parse()`

Async schemas throw because Env validation currently requires sync schemas.
