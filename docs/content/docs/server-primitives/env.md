---
title: Env
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 2
navigation.group: Application
icon: i-lucide-key-round
---

Use Env to declare browser-safe values, build replacements, server-only values, and secrets without mixing their access rules. ViteHub generates typed imports for browser and server code and redacts Secret Env values by default.

Your host still stores and supplies secrets. Server code calls `unseal()` only where it needs the raw value.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/env @vite-hub/runtime
```

### Configure

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme' }),
    },
  },
})
```

### Start using it

```ts [src/app.ts]
import { usePublicEnv } from '#vitehub/env/public'

const publicEnv = usePublicEnv()
console.log(publicEnv.appName)
```

::

## Public imports

| Import | Use |
| --- | --- |
| `env` from `@vite-hub/env` or `@vite-hub/env/vite` | Declare Env values and Env Sources. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Inspect operational Env failures by `ENV_*` code. |
| `hubEnv` from `@vite-hub/env/vite` | Register the Vite Integration. |
| `usePublicEnv` from `#vitehub/env/public` | Read generated Public Env from browser-safe code. |
| `useServerEnv` from `#vitehub/env/server` | Read generated Server Env from server code. |
| `SecretEnv` from `@vite-hub/env` or `@vite-hub/env/secret` | Represent Secret Env values that redact by default. |
| `resolveServerEnv` from `@vite-hub/env` or `@vite-hub/env/server` | Resolve a server env registry manually. |
| `openWorkflowEnv` from `@vite-hub/env` or `@vite-hub/env/presets` | Use the OpenWorkflow env preset. |
| `parseSchema` from `@vite-hub/env` or `@vite-hub/env/schema` | Parse Standard Schema-compatible values. |

## Configure Env

Add `hubEnv()` and declare values in the Vite config. `env.public` becomes browser-safe Public Env, `env.define` becomes Vite replacements, and `env.server` becomes Server Env for server runtime code.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv()],
  env: {
    public: {
      appName: env({ default: 'Acme' }),
    },
    define: {
      __BUILD_TARGET__: env({ default: 'preview' }),
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
| `prefix` | `string` | None | Prefixes env variable lookup names. |
| `projectRoot` | `string` | ViteHub project root | Resolves generated files and package import updates from a custom project root. |
| `runtimeImports.secret` | `string` | `@vite-hub/env/secret` | Replaces the type import used for `SecretEnv` in generated Server Env modules. Framework integrations can point generated code at their runtime-owned entry point. |
| `runtimeImports.server` | `string` | `@vite-hub/env/server` | Replaces the `resolveServerEnv` import used by generated Server Env modules. Framework integrations can point generated code at their runtime-owned entry point. |

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
| `schema` | Standard Schema-compatible parser | string parser | Validates and parses the value. |
| `secret` | `boolean` | `false` | Wraps runtime values in `SecretEnv`. |
| `type` | `string` | Inferred | Overrides the generated type label. |

## Env sources

| Source helper | Description |
| --- | --- |
| `env.source('NAME')` | Reads one host env variable. |
| `env.source(['PRIMARY', 'FALLBACK'])` | Reads the first available env variable from a list. |
| `env.custom(label, resolver)` | Resolves from a custom callback. |
| `env.gitBranch()` | Reads the current Git branch. |
| `env.gitCommit({ short })` | Reads the current Git commit. |
| `env.gitRef()` | Reads the current Git ref. |
| `env.gitSha({ short })` | Reads the current Git SHA. |
| `env.gitTag()` | Reads the current Git tag. |
| `env.buildTimestamp()` | Reads the build timestamp. |
| `env.packageJson(path)` | Reads a value from `package.json`. |

## Use it at runtime

Use Public Env from browser-safe code. The import path stays stable even though ViteHub generates the backing module.

```ts [src/config.ts]
import { usePublicEnv } from '#vitehub/env/public'

export const appName = usePublicEnv().appName
```

Use Server Env from server-only code. Secret Env values redact by default and require `unseal()` before a third-party SDK or request can receive the underlying string.

```ts [server/github.ts]
import { useServerEnv } from '#vitehub/env/server'

export async function listIssues() {
  const { github } = useServerEnv()

  return fetch('https://api.github.com/issues', {
    headers: {
      authorization: `Bearer ${github.token.unseal()}`,
    },
  })
}
```

## Structured errors

Env resolution failures use `ViteHubError` with closed, stable codes and JSON-safe context. The codes distinguish invalid declarations, missing required values, invalid runtime values, and failed built-in sources. Custom source resolvers keep application-owned errors unchanged.

```ts
import { getViteHubErrorShape } from '@vite-hub/runtime'

try {
  await resolveEnv()
}
catch (error) {
  const shape = getViteHubErrorShape(error)
  if (shape?.code === 'ENV_SOURCE_FAILED') {
    console.error('Env source failed', shape.details?.source)
  }
  throw error
}
```

Each code owns a fixed public message and bounded details. Source details use identifiers such as `git:branch`, `package.json`, `env`, or `custom`; raw variable names, package paths, labels, and provider diagnostics remain behind `cause`. `error.toJSON()` includes `code`, `message`, and `details`; it omits `cause`, which remains available only on the in-memory error. Invalid calls to declaration helpers remain `TypeError`, while `parseSchema()` continues to throw ordinary schema errors.

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

## Use Env with Agents

Read application secrets through Server Env inside Agent and Capability callbacks. Don't pass secrets through Agent Invocation metadata or model-facing instructions.

Env is usually not an agent-facing Capability. Other Capabilities consume Server Env when they need credentials, provider tokens, or app-owned configuration.

## Production checks

Public Env and Vite define values are visible to built client code. Put secrets only in Server Env with `secret: true`.

Secret Env provides type friction and default redaction, but it is not a complete leak-prevention system. Unseal secrets as late as possible and avoid returning them in responses, logs, traces, or Agent output.

## Next steps

- Learn the server primitive model in [Server primitives for any host](/docs/concepts/server-primitives-for-any-host).
- Use Env with [Auth](/docs/server-primitives/auth) when Auth runtime options need secrets.
- Expose agent abilities through [Official capabilities](/docs/capabilities/official-capabilities) without making secrets model-facing.
