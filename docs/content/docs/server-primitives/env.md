---
title: Env
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 2
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
      appName: env({ default: 'Acme', mode: 'build' }),
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
| `defineEnvProvider` from `@vite-hub/env/provider` | Define a read-only runtime provider for external Env storage. |
| `loadServerEnv` from `#vitehub/env/server` | Load one immutable Server Env snapshot, including provider-backed values. |
| `inspectServerEnv` from `#vitehub/env/server` | Inspect status-only Server Env metadata without returning values. |
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
| `prefix` | `string` | None | Prefixes env variable lookup names. |
| `projectRoot` | `string` | ViteHub project root | Resolves generated files and package import updates from a custom project root. |
| `providers` | `Record<string, string>` | None | Maps runtime provider names to application module specifiers. Relative specifiers resolve from the ViteHub project root. |
| `runtimeImports.secret` | `string` | `@vite-hub/env/secret` | Replaces the type import used for `SecretEnv` in generated Server Env modules. Framework integrations can point generated code at their runtime-owned entry point. |
| `runtimeImports.server` | `string` | `@vite-hub/env/server` | Replaces the runtime facade used by generated Server Env modules. The facade must export `resolveServerEnv`, `loadServerEnv`, and `inspectServerEnv`. Framework integrations can point generated code at their runtime-owned entry point. |

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
| `env.provider(name, key)` | Reads one declared key from a configured runtime provider snapshot. Server Env only. |

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

## Read external Env storage

Use an Env provider when application-owned credentials live outside the host environment. The provider is a runtime adapter, not a ViteHub secret store: your application chooses the external system, supplies its bootstrap credential through ordinary host Env, and owns its access policy.

Configure the provider module and declare only the keys the application uses.

```ts [vite.config.ts]
import { env, hubEnv } from '@vite-hub/env/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubEnv({
    providers: {
      credentials: './server/env/credentials.ts',
    },
  })],
  env: {
    server: {
      credentialsGatewayKey: env({ secret: true }),
      codexAuthJson: env({
        secret: true,
        source: env.provider('credentials', 'codex/auth.json'),
      }),
      githubToken: env({
        secret: true,
        source: env.provider('credentials', 'github/token'),
      }),
    },
  },
})
```

The provider reads all requested keys once. It receives a frozen snapshot containing only literal and host-backed Server Env values, so a Kubernetes or Cloudflare secret can authenticate the external store without importing `#vitehub/env/server` recursively.

```ts [server/env/credentials.ts]
import { defineEnvProvider } from '@vite-hub/env/provider'
import type { SecretEnv } from '@vite-hub/env/secret'

export default defineEnvProvider<{
  credentialsGatewayKey: SecretEnv<string>
}>({
  async read({ env, keys, signal }) {
    const response = await fetch('https://credentials.internal/env', {
      headers: {
        authorization: `Bearer ${env.credentialsGatewayKey.unseal()}`,
      },
      signal,
    })
    const values = await response.json() as Record<string, string | undefined>
    return Object.fromEntries(keys.map(key => [key, values[key]]))
  },
})
```

Call `loadServerEnv()` at the application operation boundary. Each call creates a new deeply frozen snapshot, deduplicates keys within that load, and does not cache values across loads. Rotation is visible to the next load while an in-flight operation keeps one coherent snapshot.

```ts [server/sources/private-repository.ts]
import { loadServerEnv } from '#vitehub/env/server'
import { github } from 'vite-hub/workspace'

export const privateRepository = github(async () => {
  const env = await loadServerEnv()
  return {
    auth: env.githubToken.unseal(),
    repo: 'acme/private-repository',
  }
})
```

This GitHub token authenticates application-owned Source materialization; it is separate from model or shell credentials such as Codex auth or `GH_TOKEN` inside an Agent workspace.

`useServerEnv()` remains synchronous for host and literal values. In a mixed registry those fields remain readable, but accessing a provider-backed field through `useServerEnv()` throws `ENV_ASYNC_REQUIRED`; use `loadServerEnv()` for the complete snapshot. `runWithServerEnv()` also loads the complete async snapshot before invoking its callback.

`inspectServerEnv()` uses the same provider load boundary and reports only declaration paths, source kinds, masking, and `available`, `defaulted`, `missing`, `invalid`, or `error` status. It never includes values, hashes, lengths, provider keys, or provider failure text. This is the safe primitive for future CLI and Console projections.

Provider reads are read-only and receive the caller's abort signal. ViteHub does not add writes, rotation commands, watches, leases, or cross-request caches. Providers must not import the generated Server Env module; use the local `env` snapshot passed to `read()` for bootstrap credentials.

## Structured errors

Env resolution failures use `ViteHubError` with closed, stable codes and JSON-safe context. The codes distinguish invalid declarations, synchronous access to provider-backed values, missing required values, invalid runtime values, and failed sources. Custom build source resolvers keep application-owned errors unchanged.

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

Each code owns a fixed public message and bounded details. Source details use identifiers such as `git:branch`, `package.json`, `env`, `provider`, or `custom`; raw variable names, provider keys, package paths, labels, and provider diagnostics remain behind `cause`. `error.toJSON()` includes `code`, `message`, and `details`; it omits `cause`, which remains available only on the in-memory error. Invalid calls to declaration helpers remain `TypeError`, while `parseSchema()` continues to throw ordinary schema errors.

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
