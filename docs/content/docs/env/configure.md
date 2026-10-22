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
