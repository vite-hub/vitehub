---
title: Env configuration
description: Declare Public Env, Define Env, and Server Env values, their sources, and their types.
navigation.title: Configure
navigation.order: 3
icon: i-lucide-sliders-horizontal
---

## Configure Env

Add `hubEnv()` and declare values in the Vite config. `env.public` becomes browser-safe Public Env, `env.define` becomes Vite replacements, and `env.server` becomes Server Env for server runtime code.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
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
})
```

## Integration options

Pass Integration Options to `hubEnv()`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `diagnostics` | `EnvDiagnostics` | Package default | Controls Env diagnostic output during Vite config/dev/build. Values: `off`, `summary`, `trace`. |
| `prefix` | `string \| false` | `'VITEHUB_'` | Prefix of [canonical variable names](#variable-names). `false` disables canonical names. |
| `projectRoot` | `string` | ViteHub project root | Resolves generated files and package import updates from a custom project root. |
| `providers` | `Record<string, string>` | None | Maps runtime provider names to application module specifiers. Relative specifiers resolve from the ViteHub project root. |
| `runtimeImports.secret` | `string` | `@vite-hub/env/secret` | Replaces the type import used for `SecretEnv` in generated Server Env modules. Framework integrations can point generated code at their runtime-owned entry point. |
| `runtimeImports.server` | `string` | `@vite-hub/env/server` | Replaces the runtime facade used by generated Server Env modules. The facade must export `resolveServerEnv`, `loadServerEnv`, and `inspectServerEnv`, and the `EnvAccessContext` type used by generated declarations. Export `createServerEnvManagement` to enable credential management; without it, the other Env operations still work. Framework integrations can point generated code at their runtime-owned entry point. |

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
| `source` | `EnvSource` or `EnvSourceResolver` | Section key lookup | Selects where the value comes from. |
| `default` | `unknown` | None | Value used when the source is absent. |
| `required` | `boolean` | `true` unless `optional` is set | Throws when a runtime value is missing. |
| `optional` | `boolean` | `false` | Sets `required` to `false`. Cannot be combined with `required`. |
| `mode` | `EnvMode` | `runtime` | Marks the value as Build Env or Runtime Env. Values: `build`, `runtime`. |
| `schema` | Standard Schema-compatible parser | string parser | Validates and parses `env.public` and `env.define` values. `env.server` accepts only the built-in parsers below because the generated runtime must serialize them. |
| `secret` | `boolean` | `false` | Wraps runtime values in `SecretEnv`. |
| `type` | `string` | Inferred | Overrides the generated type label for `env.public` and `env.define`. In `env.server`, it must match the parser. |

## Typed values

Host variables and provider values are strings. Use a typed declaration when server code needs another type. ViteHub parses the value when Server Env resolves, generates the exact TypeScript type, and rejects an invalid value with `ENV_RUNTIME_VALUE_INVALID`.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
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
})
```

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
| `env.boolean()` | `true`, `false`, `1`, or `0`, ignoring case and surrounding spaces | `boolean` |
| `env.number()` | A string that converts to a finite number | `number` |
| `env.enum(['a', 'b'])` | One of the listed strings | `"a" \| "b"` |

The typed helpers accept every `env()` option except `schema` and `type`. A `default` uses the parsed type, for example `env.boolean({ default: false })`. With `secret: true`, the value is `SecretEnv<boolean>` or `SecretEnv<number>`. `env.enum()` cannot be secret: its allowed values appear in the generated types, the Console, and error causes. Cloudflare `vars` that are already booleans or numbers are accepted as they are.

The error details contain the declaration path and source kind. The rejected value is never included. `inspectServerEnv()` reports a value that does not parse as `invalid`.

The helpers also work in `env.public` and `env.define` with `mode: 'build'`.

## Import an environment schema

Use `envSchema()` to make a committed `.env.example` the contract for both typed accessors and runtime checks. This is an explicit opt-in. Existing declarations remain available when a code-first schema fits better.

```ts [vite.config.ts]
import { envSchema, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: envSchema(new URL('./.env.example', import.meta.url)),
})
```

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

The example produces `usePublicEnv().appName`, `useServerEnv().retries`, `useServerEnv().dryRun`, and a `SecretEnv<string>` at `useServerEnv().apiToken`. Public fields resolve at build time. Private fields resolve at server runtime, so a deployment-only secret is not required during prepare or build.

The importer uses the restricted `env-spec-v1` profile from the [Nuxt module](https://nuxt-safe-runtime-config.onmax.me), with [@env-spec comment syntax](https://varlock.dev/env-spec/reference/). ViteHub owns its environment reader and serializable runtime parsers. The importer does not load developer `.env` files, fetch secrets, run Varlock, or evaluate dynamic expressions.

### Review defaults before opting in

A nonempty assignment supplies a real default. `KEY=` has no default, while `KEY=""` explicitly declares an empty string. Use `@example="sample"` for documentation without a runtime value. Unlike a conventional example file, placeholder assignments become defaults here.

All fields are required and sensitive unless a static annotation changes that. `@optional` is the inverse of `@required`; `@public` is the inverse of `@sensitive`. An unannotated type is always string. Numeric-looking strings keep their contents, including leading zeroes.

| Type annotation | Result |
| --- | --- |
| `@type=string(minLength=1, maxLength=80)` | String with inclusive length constraints. |
| `@type=number(min=0, max=100, isInt=true)` | Finite decimal number with bounds and an optional safe-integer constraint. |
| `@type=boolean` | Boolean parsed from `true`, `false`, `1`, or `0`. |
| `@type=enum(draft, send)` | String union. Mark the field non-sensitive because choices appear in metadata. |
| `@type=array(string)` | JSON array with typed items. |
| `@type=object(enabled=boolean, retries=number)` | Exact JSON object shape with required properties. |
| `@type=url` | Absolute URL validated with the platform `URL` constructor; output remains a string. |

Required empty inputs fail even when a default exists. Optional empty strings remain strings and obey length constraints. Optional empty inputs for other types count as missing, so a default applies when present. Invalid present values fail instead of falling back to a default. Defaults receive the same type and constraint checks.

### Control names and exposure

The default prefix is `VITEHUB_`. Only keys beginning with `VITEHUB_PUBLIC_` enter Public Env. They must be explicitly non-sensitive. Marking a private field `@public` clears sensitivity but keeps it on the server. This rule prevents a metadata annotation alone from moving a value into the browser.

```ts
env: envSchema(new URL('./.env.example', import.meta.url), {
  prefix: 'APP_',
  paths: { APP_DATABASE_URL: 'database.url' },
})
```

With `prefix: 'APP_'`, only `APP_PUBLIC_` names enter Public Env. With `prefix: ''`, `PUBLIC_` marks public names. Keys without the configured prefix stay private. Output names strip the prefix and use camel case. Groups are created only by explicit `paths` mappings. Public paths must be flat; unsafe, duplicate, or overlapping paths fail.

Each field reads its exact schema key with canonical lookup disabled. For example, mapping `DATABASE_URL` to `database.url` continues to read `DATABASE_URL`; `VITEHUB_DATABASE_URL` cannot override it. This differs from ordinary code-first declarations described below.

The profile accepts only supported static annotations and type constraints. It rejects dynamic expansion, secret-provider functions, duplicate declarations and decorators, and unknown arguments. Generated types describe `usePublicEnv()` and `useServerEnv()` after validation. `process.env` remains raw string input.

## Variable names

Every env-backed declaration reads two kinds of variable name, in this order:

1. The canonical name: `VITEHUB_` and the declaration path in upper snake case. `env.server.cliproxy.apiKey` reads `VITEHUB_CLIPROXY_API_KEY`, and `env.public.appName` reads `VITEHUB_PUBLIC_APP_NAME`.
2. The conventional names: the names in `env.source()`, or the path name without a prefix, such as `CLIPROXY_API_KEY`.

```ts [vite.config.ts]
server: {
  // Reads VITEHUB_GITHUB_TOKEN, then GITHUB_TOKEN.
  github: { token: env({ secret: true, source: env.source('GITHUB_TOKEN') }) },
  // Reads VITEHUB_LOG_LEVEL, then LOG_LEVEL.
  logLevel: env({ default: 'info' }),
}
```

Use the conventional name for values that a vendor documents, such as `OPENAI_API_KEY`. Use the canonical name when the conventional name is taken by something else, for example `GITHUB_TOKEN` in CI, or when you want to set any declared value without reading the config. The canonical name always wins.

Built-in Channels and gateway presets follow the same rule: their vendor names are the conventional names, so `telegram()` reads `VITEHUB_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`.

- `env.provider()`, Git, `package.json`, and custom sources have no canonical name.
- A key that is not a JavaScript identifier, such as `'api-key'` or `'nested.token'`, has no canonical name.
- Two declarations that produce the same canonical name, such as `apiKey` and `api_key`, fail with `ENV_DECLARATION_INVALID`. Rename one, or set `hubEnv({ prefix: false })`.
- `hubEnv({ prefix: 'APP_' })` changes the prefix. `hubEnv({ prefix: false })` reads only the conventional names.

Inspection reports `via: 'canonical'` or `via: 'conventional'` for each available value. It reports `conflict: true` when the canonical name and a conventional name hold different values; the canonical value is used. `describeServerEnv()` includes `canonicalName`. Conventional names stay out of inspection output.

On Cloudflare, a required secret is listed in the Wrangler config only when it accepts one exact name. Canonical and conventional alternatives remain runtime-only because Wrangler cannot express fallback names. Use `hubEnv({ prefix: false })` or an explicit source equal to the canonical name when an exact Wrangler requirement is needed.

## Env sources

| Source helper | Description |
| --- | --- |
| `env.source('NAME')` | Reads one host env variable. |
| `env.source(['PRIMARY', 'FALLBACK'])` | Reads the first available env variable from a list. |
| `env.source(['PRIMARY', 'FALLBACK'], { skipEmpty: true })` | Reads the first defined, non-empty env variable from a list. |
| `env.custom(label, resolver)` | Resolves from a custom callback. |
| `env.gitBranch()` | Reads the current Git branch. |
| `env.gitCommit({ short })` | Reads the current Git commit. |
| `env.gitRef()` | Reads the current Git ref. |
| `env.gitSha({ short })` | Reads the current Git SHA. |
| `env.gitTag()` | Reads the current Git tag. |
| `env.buildTimestamp()` | Reads the build timestamp. |
| `env.packageJson(path)` | Reads a value from `package.json`. |
| `env.provider(name, key)` | Reads one declared key from a configured runtime provider snapshot. Server Env only. |

## Provider output

`hubEnv()` writes generated env modules under `.vitehub/env/` and ambient types under `.vitehub/types/`. Import `#vitehub/env/public` and `#vitehub/env/server` from application code, not generated file paths or integration virtual modules.

Add the generated type directory to `tsconfig.json` when the app wants field-level types for generated Env access.

```json [tsconfig.json]
{
  "include": [
    "src/**/*.ts",
    "server/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

Array and object defaults are quoted JSON, such as `VITEHUB_TAGS='["one"]'`. Types can nest, for example `array(object(name=string))`. Bare `array` and `object` accept JSON without a fixed shape. JSON members are validated without coercion; exact object shapes reject unknown or missing properties. Sensitive declarations cannot contain nested enums because their choices appear in metadata. Dynamic expressions and transforms remain available through the existing code-first APIs where supported.
