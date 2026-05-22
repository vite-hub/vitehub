---
title: Env usage
description: Use prefixes, defaults, optional values, sources, schemas, diagnostics, and server-only secrets.
navigation.title: Usage
navigation.order: 2
icon: i-lucide-file-code-2
frameworks: [vite, nitro]
---

Use this page after the [Quickstart](./quickstart) when you need more control over where values come from and when they are exposed.

## Use inferred env names

When a declaration has no explicit source, Env infers an environment variable name from the config path.

```ts
env: {
  auth: {
    token: env({ secret: true }),
  },
}
```

The inferred runtime source is `AUTH_TOKEN`.

Set `prefix` to require a prefix before inferred names:

```ts
envVite({ prefix: 'VITEHUB_' })
envNitro({ prefix: 'VITEHUB_' })
```

With that prefix, `env.auth.token` reads `VITEHUB_AUTH_TOKEN`.

## Set defaults

Use `default` when local development can use a safe fallback.

```ts
env: {
  app: {
    name: env({
      default: 'Docs App',
    }),
  },
}
```

Defaults are still validated.

## Mark values optional

Use `optional: true` when missing values should resolve to `undefined`.

```ts
env: {
  optionalApiBase: env({
    optional: true,
  }),
}
```

Do not combine `optional` and `required`. `env()` rejects declarations that set both.

## Use explicit sources

Use `env.source()` when the env var name should not be inferred from the config path.

```ts
import { env } from '@vitehub/env/nitro'

env: {
  optionalApiBase: env({
    optional: true,
    source: env.source('PUBLIC_API_BASE'),
  }),
}
```

Use build-only sources for values that can be resolved during Vite config:

```ts
import { env } from '@vitehub/env/vite'

env: {
  define: {
    __APP_VERSION__: env({
      mode: 'build',
      source: env.packageJson('version'),
    }),
    __GIT_COMMIT__: env({
      mode: 'build',
      source: env.gitCommit({ short: true }),
    }),
  },
}
```

Custom sources are build-only because Nitro runtime registries must be serializable.

## Validate values

The default schema accepts strings. Pass a sync zod-like schema or Standard Schema-compatible validator for build values.

```ts
const booleanSchema = {
  safeParse(input: unknown) {
    if (input === 'true') return { success: true, data: true }
    if (input === 'false') return { success: true, data: false }
    return { success: false, error: new Error('Expected boolean') }
  },
}

env: {
  define: {
    __SENTRY_DEBUG__: env({
      mode: 'build',
      schema: booleanSchema,
      type: 'boolean',
    }),
  },
}
```

Runtime registries currently support the built-in string validation shape. Use custom runtime schema validation in application code after reading the value.

## Read Public Env

Use `env.public` for values available through `#vitehub/env/public`.

```ts
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()

console.log(publicEnv.appName)
```

Use `env.define` for compile-time replacements.

```ts
console.log(__APP_VERSION__)
```

## Read Server Env

Use `useServerEnv()` in server code.

```ts
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  const config = useServerEnv(event)
  return {
    appName: config.app.name,
  }
})
```

Secret runtime declarations resolve to `SecretEnv` objects. They redact through string coercion and JSON serialization; call `.unseal()` only at the boundary that needs the raw value.

```ts
import { useServerEnv } from '#vitehub/env/server'

export default defineEventHandler((event) => {
  const config = useServerEnv(event)

  return createAuthClient({
    token: config.auth.token.unseal(),
  })
})
```

When application helpers need an explicit Server Env type, import the generated type from the same module instead of declaring your own interface.

```ts
import type { ServerEnv } from '#vitehub/env/server'

export function createAgent(config: ServerEnv) {
  return createVertex({ apiKey: config.vertex.apiKey.unseal() })(config.vertex.model)
}
```

The Nitro module also augments Nitro runtime config as the framework transport. Application code should read these values through `useServerEnv()`.

## Enable diagnostics

Use `diagnostics: 'summary'` or `diagnostics: 'trace'` while setting up config.

```ts
plugins: [envVite({ diagnostics: 'trace' })]
```

Diagnostics show which declarations are valid, missing, defaulted, or masked. Secret values are not printed.
