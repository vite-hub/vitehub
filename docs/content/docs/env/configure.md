---
title: Env configuration
description: Declare Public Env, Define Env, and Server Env values, their sources, and their types.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure Env

Declare values in `vitehub({ env })`, in `vitehub.env` in Nuxt, or in `hubEnv(options)` without `vite-hub`. `env.public` is browser-safe Public Env. `env.define` becomes Vite replacements. `env.server` is Server Env, for server code only.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
      define: {
        __BUILD_TARGET__: env({ default: 'preview', mode: 'build' }),
      },
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
      define: {
        __BUILD_TARGET__: env({ default: 'preview', mode: 'build' }),
      },
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      public: {
        appName: env({ default: 'Acme', mode: 'build' }),
      },
      define: {
        __BUILD_TARGET__: env({ default: 'preview', mode: 'build' }),
      },
      server: {
        github: {
          token: env({ secret: true, source: env.source('GITHUB_TOKEN') }),
        },
      },
    },
  })],
})
```
:::
::

## Integration options

Pass these to the `env` option of `vitehub({ host: 'node' })`, or to `vitehub.env` in Nuxt.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `diagnostics` | `EnvDiagnostics` | Package default | Diagnostic output in Vite config, dev, and build: `off`, `summary`, `trace`. |
| `prefix` | `string \| false` | `'VITEHUB_'` | Prefix of [canonical variable names](#variable-names). `false` disables canonical names. |
| `projectRoot` | `string` | ViteHub project root | Custom root for generated files and package import updates. |
| `providers` | `Record<string, string>` | None | Maps runtime provider names to app modules. Relative paths start at the ViteHub project root. |
| `runtimeImports.secret` | `string` | `@vite-hub/env` | Replaces the `SecretEnv` type import in generated Server Env modules, for framework integrations. |
| `runtimeImports.server` | `string` | `@vite-hub/env/internal/server` | Replaces the runtime module of generated Server Env modules, for framework integrations. It must export `resolveServerEnv`, `loadServerEnv`, `inspectServerEnv`, and the `ViteHubContext` and `EnvAccessContext` types. Also export `createServerEnvManagement` to get credential management, and `bindServerEnvSchemas` when declarations use `env.schemaFrom()`. |

To support `deriveSecret()`, `seal()`, and `unseal()` through a custom runtime facade, re-export `deriveSecret` and `createSealing` from `@vite-hub/env/internal/server`. The generated module uses these to read the project's development secret. Also re-export `seal` and `unseal` for their public types in generated declarations. Existing Env resolution and inspection operations do not require these sealing exports.

## Env config sections

| Section | Runtime | Public | Use |
| --- | --- | --- | --- |
| `env.public` | Build | Yes | Browser-safe Public Env through `#vitehub/env/public`. |
| `env.define` | Build transform | Yes in bundled code | Vite compile-time replacements. |
| `env.server` | Server runtime | No | Server Env through `#vitehub/env/server`. |

## Env Declaration options

`env()` and `env.variable()` accept the same options.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `source` | `EnvSource` or `EnvSourceResolver` | Section key lookup | Where the value comes from. |
| `default` | `unknown` | None | Value to use when the source has none. |
| `required` | `boolean` | `true` unless `optional` is set | Throws when the runtime value is missing. Server Env checks all values at once, so one missing value fails every read. |
| `optional` | `boolean` | `false` | Sets `required` to `false`. Cannot be combined with `required`. |
| `mode` | `EnvMode` | `runtime` | Build Env or Runtime Env: `build` or `runtime`. |
| `schema` | Standard Schema-compatible parser, or `env.schemaFrom()` | string parser | Parses `env.public` and `env.define` values. `env.server` accepts the built-in parsers below, or a schema from a module through [`env.schemaFrom()`](#validate-server-env-with-your-own-schema). |
| `secret` | `boolean` | `false` | Wraps runtime values in `SecretEnv`. |
| `type` | `string` | Inferred | Overrides the generated type label in `env.public` and `env.define`. In `env.server`, it must match the parser, and `env.schemaFrom()` does not accept it. |

## Typed values

Host and provider values are strings. A typed declaration gives you another type. ViteHub parses the value when Server Env resolves, generates the TypeScript type, and rejects a bad value with `ENV_RUNTIME_VALUE_INVALID`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        labeller: {
          dryRun: env.boolean({ default: true }),
          minConfidence: env.number({ default: 0.6 }),
          mode: env.enum(['draft', 'send'], { default: 'draft' }),
          apiKey: env({ secret: true }),
        },
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        labeller: {
          dryRun: env.boolean({ default: true }),
          minConfidence: env.number({ default: 0.6 }),
          mode: env.enum(['draft', 'send'], { default: 'draft' }),
          apiKey: env({ secret: true }),
        },
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        labeller: {
          dryRun: env.boolean({ default: true }),
          minConfidence: env.number({ default: 0.6 }),
          mode: env.enum(['draft', 'send'], { default: 'draft' }),
          apiKey: env({ secret: true }),
        },
      },
    },
  })],
})
```
:::
::

```ts [server/labeller.ts]
import { useServerEnv } from '#vitehub/env/server'

const { labeller } = useServerEnv()
if (!labeller.dryRun && labeller.mode === 'send') {
  // labeller.minConfidence is a number.
}
```

| Declaration | Accepted input | Generated type |
| --- | --- | --- |
| `env()` | Any string | `string` |
| `env.boolean()` | `true`, `false`, `1`, or `0`, any case, spaces trimmed | `boolean` |
| `env.number()` | A finite number | `number` |
| `env.enum(['a', 'b'])` | One of the listed strings | `"a" \| "b"` |

Typed helpers accept every `env()` option except `schema` and `type`. A `default` uses the parsed type, for example `env.boolean({ default: false })`. With `secret: true`, you get `SecretEnv<boolean>` or `SecretEnv<number>`. `env.enum()` cannot be secret, because its choices appear in generated types, the Console, and error causes. Cloudflare `vars` that are already booleans or numbers pass as they are.

Error details hold the declaration path and source kind, never the rejected value. `inspectServerEnv()` reports a value that does not parse as `invalid`.

The helpers also work in `env.public` and `env.define` with `mode: 'build'`.

## Validate Server Env with your own schema

Use `env.schemaFrom(module, exportName)` when a Server Env value needs more than the built-in parsers, such as a pattern, a custom refinement, or a transform. Export a [Standard Schema](https://standardschema.dev) from a module. The server build imports that module, and Server Env runs the schema on the raw value each time it resolves.

```ts [server/env.schema.ts]
import { z } from 'zod'

export const apiUrl = z.url().refine(url => url.startsWith('https://'), 'Use an https URL.')
export const retries = z.coerce.number().int().min(1).max(5)
export const tags = z.string().transform(value => value.split(','))
export const token = z.string().min(20)
```

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        apiUrl: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiUrl') }),
        retries: env({ default: '2', schema: env.schemaFrom('./server/env.schema.ts', 'retries') }),
        tags: env({ schema: env.schemaFrom('./server/env.schema.ts', 'tags') }),
        token: env({ secret: true, schema: env.schemaFrom('./server/env.schema.ts', 'token') }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        apiUrl: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiUrl') }),
        retries: env({ default: '2', schema: env.schemaFrom('./server/env.schema.ts', 'retries') }),
        tags: env({ schema: env.schemaFrom('./server/env.schema.ts', 'tags') }),
        token: env({ secret: true, schema: env.schemaFrom('./server/env.schema.ts', 'token') }),
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        apiUrl: env({ schema: env.schemaFrom('./server/env.schema.ts', 'apiUrl') }),
        retries: env({ default: '2', schema: env.schemaFrom('./server/env.schema.ts', 'retries') }),
        tags: env({ schema: env.schemaFrom('./server/env.schema.ts', 'tags') }),
        token: env({ secret: true, schema: env.schemaFrom('./server/env.schema.ts', 'token') }),
      },
    },
  })],
})
```
:::
::

`useServerEnv().retries` is a `number`, `tags` is a `string[]`, and `token` is a `SecretEnv<string>`. The generated types read the output type of each export, or use `unknown` when the schema has no type metadata.

- A relative module path resolves from the project root, as `providers` does. `exportName` defaults to `default`.
- The schema gets the raw host string, or the default as written. Use coercion, such as `z.coerce.number()`, for other types.
- The schema must be synchronous. An async schema fails with `ENV_RUNTIME_VALUE_INVALID`.
- An export that is not a Standard Schema fails when the server module loads, with `ENV_DECLARATION_INVALID`.
- For a non-secret value, the error cause contains the schema issue messages. For a secret value, it contains only the path, because issue messages can quote the input.
- `env.schemaFrom()` works only in `env.server`. In `env.public` and `env.define`, pass the schema object directly: those values resolve during the build, where the config can run it.

## Import an environment schema

Opt in with `envSchema()` to get typed accessors and runtime checks from a committed `.env.example`. Code declarations still work.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { envSchema } from '@vite-hub/env/vite'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: envSchema(new URL('./.env.example', import.meta.url)),
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { envSchema } from '@vite-hub/env/vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: envSchema(new URL('./.env.example', import.meta.url)),
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { envSchema } from '@vite-hub/env/vite'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: envSchema(new URL('./.env.example', import.meta.url)),
  })],
})
```
:::
::

```dotenv [.env.example]
# @public
VITEHUB_PUBLIC_APP_NAME=Acme

# @type=number(min=1, max=10, isInt=true) @public
VITEHUB_RETRIES=3

# @type=boolean @public
VITEHUB_DRY_RUN=false

# @example="obtain-a-token-from-the-provider"
VITEHUB_API_TOKEN=
```

This example gives `usePublicEnv().appName`, `useServerEnv().retries`, `useServerEnv().dryRun`, and a `SecretEnv<string>` at `useServerEnv().apiToken`. Public fields resolve at build time. Private fields resolve at server runtime, so prepare and build do not need a deployment-only secret.

It uses the limited `env-spec-v1` profile from the [Nuxt module](https://nuxt-safe-runtime-config.onmax.me), with [@env-spec comment syntax](https://varlock.dev/env-spec/reference/). ViteHub uses its own reader and parsers. It does not load your `.env` files, fetch secrets, run Varlock, or evaluate dynamic expressions. To move an app from that module, run the [`nuxt-safe-runtime-config` codemod](/docs/codemods/nuxt-modules#nuxt-safe-runtime-config).

The [schema lab](https://github.com/vite-hub/vitehub/tree/main/packages/env/examples/schema-lab) builds a browser bundle and a Node server from one schema. Its production test checks types, startup failures, redaction, browser output, and server values that change between restarts. Public Env values are fixed at build.

### Review defaults before opting in

Unlike a usual example file, a placeholder here becomes a real default. `KEY=` has no default. `KEY=""` declares an empty string. `@example="sample"` documents a value without a default.

Every field is required and sensitive unless an annotation changes that. `@optional` reverses `@required`, and `@public` reverses `@sensitive`. A field without a type is a string, and keeps leading zeroes.

| Type annotation | Result |
| --- | --- |
| `@type=string(minLength=1, maxLength=80)` | String with inclusive length limits. |
| `@type=number(min=0, max=100, isInt=true)` | Finite decimal number with bounds and an optional safe-integer check. |
| `@type=boolean` | Boolean parsed from `true`, `false`, `1`, or `0`. |
| `@type=enum(draft, send)` | String union. Mark it non-sensitive, because the choices appear in metadata. |
| `@type=array(string)` | JSON array with typed items. |
| `@type=object(enabled=boolean, retries=number)` | Exact JSON object shape with required properties. |
| `@type=url` | Absolute URL checked with the platform `URL` constructor. The output is a string. |

- A required empty input fails, even with a default.
- An optional empty string stays a string and obeys length limits.
- An optional empty input of another type is missing, so the default applies.
- An invalid value fails. It does not fall back to the default.
- Defaults get the same checks.

### Control names and exposure

The default prefix is `VITEHUB_`. Only non-sensitive keys that start with `VITEHUB_PUBLIC_` go to Public Env. `@public` on another key clears sensitivity but keeps it on the server, so an annotation alone never moves a value to the browser.

```ts
import { envSchema } from '@vite-hub/env/vite'

env: envSchema(new URL('./.env.example', import.meta.url), {
  prefix: 'APP_',
  paths: { APP_DATABASE_URL: 'database.url' },
})
```

With `prefix: 'APP_'`, only `APP_PUBLIC_` names go to Public Env. With `prefix: ''`, `PUBLIC_` marks public names. Keys without the prefix stay private. Output names drop the prefix and use camel case. Only `paths` mappings create groups. Public paths must be flat. Unsafe, duplicate, or overlapping paths fail.

Each field reads only its exact schema key, with no canonical name. If you map `DATABASE_URL` to `database.url`, it still reads `DATABASE_URL`, and `VITEHUB_DATABASE_URL` cannot override it. Code declarations work differently.

The profile accepts only supported static annotations and type limits. It rejects dynamic expansion, secret-provider functions, duplicate declarations or decorators, and unknown arguments. Generated types describe the validated `usePublicEnv()` and `useServerEnv()`. `process.env` stays raw strings.

## Variable names

Each env-backed declaration reads two kinds of name, in this order:

1. The canonical name: `VITEHUB_` and the declaration path in upper snake case. `env.server.cliproxy.apiKey` reads `VITEHUB_CLIPROXY_API_KEY`, and `env.public.appName` reads `VITEHUB_PUBLIC_APP_NAME`.
2. The conventional names: the names in `env.source()`, or the path name without a prefix, such as `CLIPROXY_API_KEY`.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    env: {
      server: {
        // Reads VITEHUB_GITHUB_TOKEN, then GITHUB_TOKEN.
        github: { token: env({ secret: true, source: env.source('GITHUB_TOKEN') }) },
        // Reads VITEHUB_LOG_LEVEL, then LOG_LEVEL.
        logLevel: env({ default: 'info' }),
      },
    },
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        // Reads VITEHUB_GITHUB_TOKEN, then GITHUB_TOKEN.
        github: { token: env({ secret: true, source: env.source('GITHUB_TOKEN') }) },
        // Reads VITEHUB_LOG_LEVEL, then LOG_LEVEL.
        logLevel: env({ default: 'info' }),
      },
    },
  }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [vitehub({
    host: 'node',
    env: {
      server: {
        // Reads VITEHUB_GITHUB_TOKEN, then GITHUB_TOKEN.
        github: { token: env({ secret: true, source: env.source('GITHUB_TOKEN') }) },
        // Reads VITEHUB_LOG_LEVEL, then LOG_LEVEL.
        logLevel: env({ default: 'info' }),
      },
    },
  })],
})
```
:::
::

Use the conventional name for values that a vendor documents, such as `OPENAI_API_KEY`. Use the canonical name when the conventional one is taken, such as `GITHUB_TOKEN` in CI, or to set any value without reading the config. The canonical name always wins.

Built-in Channels and gateway presets use vendor names as conventional names. So `telegram()` reads `VITEHUB_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`.

- `env.provider()`, Git, `package.json`, and custom sources have no canonical name.
- A key that is not a JavaScript identifier, such as `'api-key'` or `'nested.token'`, has no canonical name.
- Two declarations that produce the same canonical name, such as `apiKey` and `api_key`, fail with `ENV_DECLARATION_INVALID`. Rename one, or set `prefix: false` in the `env` option.
- `prefix: 'APP_'` in the `env` option changes the prefix. `prefix: false` reads only the conventional names.

Inspection reports `via: 'canonical'` or `via: 'conventional'` for each value, and `conflict: true` when the two names differ. The canonical value wins. `describeServerEnv()` includes `canonicalName`. Inspection output never shows conventional names.

On Cloudflare, the Wrangler config lists a required secret only when it has one exact name. Wrangler has no fallback names, so name pairs work at runtime only. For an exact Wrangler entry, set `prefix: false`, or a source equal to the canonical name.

## Env sources

| Source helper | Description |
| --- | --- |
| `env.source('NAME')` | One host variable. |
| `env.source(['PRIMARY', 'FALLBACK'])` | The first variable that exists. |
| `env.source(['PRIMARY', 'FALLBACK'], { skipEmpty: true })` | The first variable that is not empty. |
| `env.custom(label, resolver)` | Your own callback. |
| `env.gitBranch()` | Current Git branch. |
| `env.gitCommit({ short })` | Current Git commit. |
| `env.gitRef()` | Current Git ref. |
| `env.gitSha({ short })` | Current Git SHA. |
| `env.gitTag()` | Current Git tag. |
| `env.buildTimestamp()` | Build timestamp. |
| `env.packageJson(path)` | A value from `package.json`. |
| `env.provider(name, key)` | One key from a runtime provider snapshot. Server Env only. |

## Provider output

Env writes generated modules to `.vitehub/env/` and types to `.vitehub/types/`. In app code, import `#vitehub/env/public` and `#vitehub/env/server`, not generated file paths or virtual modules.

Add the type directory to `tsconfig.json` to type each field.

```json [tsconfig.json]
{
  "include": [
    "src/**/*.ts",
    "server/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

Array and object defaults are quoted JSON, such as `VITEHUB_TAGS='["one"]'`. Types can nest, for example `array(object(name=string))`. Bare `array` and `object` accept JSON of any shape. JSON members are not coerced. Exact object shapes reject unknown or missing properties. Sensitive declarations cannot hold nested enums, because the choices appear in metadata. For dynamic expressions and transforms, use code declarations.
