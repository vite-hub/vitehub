---
title: Env
description: Declare public, build-time, server runtime, and secret values behind typed ViteHub accessors.
navigation.order: 2
navigation.group: Application
icon: i-lucide-key-round
---

Env declares the configuration values your application reads: browser-safe values, build-time replacements, server-only values, and secrets. You declare each value once in the Vite config. ViteHub generates typed imports for browser and server code and redacts Secret Env values by default.

Your host still stores and supplies the values. Server code calls `unseal()` on a secret only where it needs the raw string.

::tip
- **Env** declares values and reads them from the host or from a read-only Env provider. A change needs a new host value or the next provider read.
- **[Env Bridge](/docs/server-primitives/env-bridge)** is an Env provider that lets administrators replace credentials at runtime, with grants and an activity log.
- **[Connections](/docs/server-primitives/connections)** hold OAuth account tokens. They store tokens through Env Bridge, so application code never reads them.
- **[Auth](/docs/server-primitives/auth)** reads its own secrets from Server Env.
::

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

With the `vite-hub` package, `vitehub()` registers Env for you. Import `env` from `vite-hub/env`, pass Integration options as `vitehub({ env: { ... } })`, and set `env: false` to disable Env.

## Public imports

| Import | Use |
| --- | --- |
| `env` from `@vite-hub/env` or `@vite-hub/env/vite` | Declare Env values and Env Sources. `env.boolean()`, `env.number()`, and `env.enum()` declare typed values. |
| `hubEnv` from `@vite-hub/env/vite` | Register the Vite Integration. |
| `usePublicEnv` from `#vitehub/env/public` | Read generated Public Env from browser-safe code. |
| `useServerEnv` from `#vitehub/env/server` | Read host-backed and literal Server Env synchronously. |
| `loadServerEnv` from `#vitehub/env/server` | Load one immutable Server Env snapshot, including provider-backed values. |
| `runWithServerEnv` from `#vitehub/env/server` | Load a snapshot, then run a callback with it. |
| `describeServerEnv` from `#vitehub/env/server` | List declaration metadata without reading host values or calling providers. |
| `inspectServerEnv` from `#vitehub/env/server` | Report the status of each declaration without returning values. |
| `isBlockingServerEnvEntry` from `@vite-hub/env` or `@vite-hub/env/server` | Check whether an inspection entry makes `loadServerEnv()` fail. |
| `defineEnvProvider` from `@vite-hub/env` or `@vite-hub/env/provider` | Define a read-only runtime provider for external Env storage. |
| `SecretEnv` from `@vite-hub/env` or `@vite-hub/env/secret` | Represent Secret Env values that redact by default. |
| `resolveServerEnv` from `@vite-hub/env` or `@vite-hub/env/server` | Resolve a server Env registry manually. |
| `openWorkflowEnv`, `typesafeEnv` from `@vite-hub/env` or `@vite-hub/env/presets` | Declare preset Server Env groups. See [Presets](#presets). |
| `parseSchema` from `@vite-hub/env` or `@vite-hub/env/schema` | Parse Standard Schema-compatible values. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Inspect Env failures by `ENV_*` code. |

Applications that use `vite-hub` import the same names from `vite-hub/env` and its `provider`, `secret`, `server`, `presets`, and `schema` subpaths.

## Configure Env

Declare values under three sections of the Vite config.

| Section | Read when | Visible to client code | Use |
| --- | --- | --- | --- |
| `env.public` | Build | Yes | Browser-safe Public Env through `#vitehub/env/public`. |
| `env.define` | Build transform | Yes, where bundled | Vite compile-time replacements. |
| `env.server` | Server runtime | No | Server Env through `#vitehub/env/server`. |

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

Without `source`, ViteHub reads the host variable named after the declaration path in upper snake case. Server Env drops the `server` section name. Build Env keeps it. For example, `env.server.github.token` reads `GITHUB_TOKEN`, `env.public.appName` reads `PUBLIC_APP_NAME`, and `env.define.sentryDebug` reads `DEFINE_SENTRY_DEBUG`. The `prefix` option adds a prefix to each inferred name.

### Integration options

Pass Integration options to `hubEnv()`, or to `vitehub({ env })`.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `diagnostics` | `'off' \| 'summary' \| 'trace'` | `'summary'` | Controls Env diagnostic output during Vite config, dev, and build. |
| `prefix` | `string` | None | Prefixes inferred host variable names. |
| `projectRoot` | `string` | ViteHub project root | Resolves generated files and package import updates from a custom project root. |
| `providers` | `Record<string, string>` | None | Maps runtime provider names to application module specifiers. Relative specifiers resolve from the ViteHub project root. |
| `runtimeImports.secret` | `string` | `@vite-hub/env/secret` | Replaces the type import used for `SecretEnv` in generated Server Env modules. `vitehub()` sets `vite-hub/env/secret`. |
| `runtimeImports.server` | `string` | `@vite-hub/env/server` | Replaces the runtime facade used by generated Server Env modules. The facade must export `resolveServerEnv`, `loadServerEnv`, `inspectServerEnv`, and the `EnvAccessContext` type. Export `createServerEnvManagement` to enable credential management; without it, the other Env operations still work. `vitehub()` sets `vite-hub/env/server`. |

### Env Declaration options

`env()` and `env.variable()` accept the same options.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `source` | `EnvSource` or `EnvSourceResolver` | Inferred host variable | Selects where the value comes from. See [Env sources](#env-sources). |
| `default` | `unknown` | None | Value used when the source is absent. |
| `required` | `boolean` | `true` unless `optional` is set | Fails when a runtime value is missing. |
| `optional` | `boolean` | `false` | Sets `required` to `false`. Cannot be combined with `required`. |
| `mode` | `'build' \| 'runtime'` | `'runtime'` | Marks the value as Build Env or Runtime Env. `env.public` and `env.define` require `'build'`. `env.server` requires `'runtime'`. |
| `schema` | Standard Schema-compatible parser | String parser | Validates and parses `env.public` and `env.define` values. `env.server` accepts only the typed helpers below because the generated runtime must serialize the parser. |
| `secret` | `boolean` | `false` | Wraps runtime values in `SecretEnv`. `env.public` and `env.define` values cannot be secret because they are bundled. |
| `type` | `string` | Inferred | Overrides the generated type label for `env.public` and `env.define`. In `env.server`, it must match the parser. |

### Typed values

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

- The typed helpers accept every `env()` option except `schema` and `type`.
- A `default` uses the parsed type, for example `env.boolean({ default: false })`.
- With `secret: true`, the value is `SecretEnv<boolean>` or `SecretEnv<number>`.
- `env.enum()` cannot be secret: its allowed values appear in the generated types, the Console, and error causes.
- Cloudflare `vars` that are already booleans or numbers are accepted as they are.
- The helpers also work in `env.public` and `env.define` with `mode: 'build'`.

The error details contain the declaration path and source kind. The rejected value is never included. `inspectServerEnv()` reports a value that does not parse as `invalid`.

### Env sources

| Source helper | Description |
| --- | --- |
| `env.source('NAME')` | Reads one host variable. |
| `env.source(['PRIMARY', 'FALLBACK'])` | Reads the first defined host variable from a list. |
| `env.source(['PRIMARY', 'FALLBACK'], { skipEmpty: true })` | Reads the first defined, non-empty host variable from a list. |
| `env.custom(label, resolver)` | Resolves from a custom callback. |
| `env.gitBranch()` | Reads the current Git branch. |
| `env.gitCommit({ short })` | Reads the current Git commit. |
| `env.gitRef()` | Reads the current Git ref. |
| `env.gitSha({ short })` | Reads the current Git SHA. |
| `env.gitTag()` | Reads the current Git tag. |
| `env.buildTimestamp()` | Reads the build timestamp. |
| `env.packageJson(path)` | Reads a value from `package.json`. |
| `env.provider(name, key)` | Reads one key from a configured runtime provider snapshot. Server Env only. |

`env.server` accepts only `env.source()` and `env.provider()`. The other helpers resolve at build time and work only in `env.public` and `env.define`.

### Presets

Presets return ordinary `env.server` declarations.

| Preset | Declares |
| --- | --- |
| `openWorkflowEnv({ namespaceId?, schema?, workerConcurrency? })` | OpenWorkflow namespace, optional Secret Postgres URL (`OPENWORKFLOW_POSTGRES_URL`, then `DATABASE_URL`), schema, and worker concurrency. |
| `typesafeEnv({ provider?, model? })` | The TypeSafe Jev `provider`, Secret `apiKey`, and `model` group for the ask Driver. See [Connect Env to Agents](#connect-env-to-agents). |

## Providers

Env reads values from the host where the code runs. ViteHub does not store or provision them.

| Value | Read from |
| --- | --- |
| Build Env (`env.public`, `env.define`) | The Vite env files for the current mode and `process.env`, at build time. `process.env` takes precedence. |
| Host-backed Server Env | `process.env` and, on Cloudflare Workers, the Worker env, at runtime. Worker values take precedence. |
| Provider-backed Server Env | The Env provider module that `providers` maps to the name in `env.provider(name, key)`. See [Read external Env storage](#read-external-env-storage). |

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

`useServerEnv()` is synchronous and reads host-backed and literal values. Accessing a provider-backed field through `useServerEnv()` throws `ENV_ASYNC_REQUIRED`. Use `loadServerEnv()` or `runWithServerEnv()` for the complete snapshot.

## Read external Env storage

Use an Env provider when application-owned credentials live outside the host environment. The provider is a runtime adapter, not a ViteHub secret store. Your application chooses the external system, supplies its bootstrap credential through ordinary host Env, and owns its access policy.

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

The provider reads all requested keys once per load. It receives a frozen snapshot that contains only literal and host-backed Server Env values. A Kubernetes or Cloudflare secret can therefore authenticate the external store without a recursive import of `#vitehub/env/server`.

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

Call `loadServerEnv()` at the application operation boundary.

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

This GitHub token authenticates application-owned Source materialization. It is separate from model or shell credentials such as Codex auth or `GH_TOKEN` inside an Agent workspace.

Each `loadServerEnv()` call:

- creates a new, deeply frozen snapshot;
- reads each provider key once within that load;
- does not cache values across loads, so a rotated value is visible to the next load;
- passes the caller's abort signal to provider `read()`.

An in-flight operation keeps one coherent snapshot. Env adds no watches, leases, or cross-request caches. Providers are read-only and must not import the generated Server Env module; use the `env` snapshot passed to `read()` for bootstrap credentials. For credentials that administrators replace at runtime, use [Env Bridge](/docs/server-primitives/env-bridge).

## Inspect and check Server Env

| Function | Reads values or calls providers | Returns |
| --- | --- | --- |
| `describeServerEnv()` | No | Declaration paths, source kinds, provider aliases, secret and required flags, whether a default exists, and the parsed value type such as `boolean` or `"draft" \| "send"`. |
| `inspectServerEnv()` | Yes, through the same load boundary as `loadServerEnv()` | The same paths with source kinds, provider aliases, masking, required flags, and an `available`, `defaulted`, `missing`, `invalid`, or `error` status. |

Neither function returns values, hashes, lengths, defaults, host variable names, provider keys, provider module paths, or provider failure text. `isBlockingServerEnvEntry(entry)` returns `true` for an entry that makes `loadServerEnv()` fail: a required value is missing, a value is invalid, or a provider failed.

Check a stage from the terminal:

```bash [Terminal]
vitehub env inspect --stage production
vitehub env check --stage production
```

Both commands load the stage's Vite env files and never print values. `env check` exits with `1` for any blocking entry, so CI and deploy steps can run it before a release. Read [CLI](/docs/development/cli#check-server-env) for options and output.

The [Console](/docs/development/console) Env section uses the same metadata and inherits Console access protection. Select **Check status** to run the inspection. For an Env Bridge provider, the detail panel also offers masked previews, runtime replacement, activity, and per-credential grants. These controls also enforce the provider's own authentication and permissions. Host variables stay read-only.

## Structured errors

Env resolution failures use `ViteHubError` with stable codes and JSON-safe details.

| Code | Cause | Details |
| --- | --- | --- |
| `ENV_DECLARATION_INVALID` | A declaration is invalid. | `path` |
| `ENV_ASYNC_REQUIRED` | `useServerEnv()` accessed a provider-backed value. | `path` |
| `ENV_REQUIRED_MISSING` | A required value is missing. | `path`, `source` |
| `ENV_RUNTIME_VALUE_INVALID` | A value does not parse for its declaration. | `path`, `source` |
| `ENV_SOURCE_FAILED` | A source or provider failed. | `source` |

```ts [server/load-env.ts]
import { loadServerEnv } from '#vitehub/env/server'
import { getViteHubErrorShape } from '@vite-hub/runtime'

try {
  await loadServerEnv()
}
catch (error) {
  const shape = getViteHubErrorShape(error)
  if (shape?.code === 'ENV_SOURCE_FAILED') {
    console.error('Env source failed', shape.details?.source)
  }
  throw error
}
```

Each code has a fixed public message. `source` is an identifier such as `git:branch`, `package.json`, `env`, `provider`, or `custom`. Raw variable names, provider keys, package paths, labels, and provider diagnostics stay in `cause`. `error.toJSON()` includes `code`, `message`, and `details`, and omits `cause`.

Custom build source resolvers keep application-owned errors unchanged. Invalid declaration helper calls and schema results use package-owned `ENV_R####` codes. Build integration defects use `ENV_B####` codes. Read [Errors and diagnostics](/docs/reference/errors-diagnostics) for the shared contract.

## Provider output

`hubEnv()` writes generated Env modules under `.vitehub/env/` and ambient types to `.vitehub/types/env.d.ts`. Import `#vitehub/env/public` and `#vitehub/env/server` from application code, not generated file paths.

Add the generated type directory to `tsconfig.json` for field-level types.

```json [tsconfig.json]
{
  "include": [
    "src/**/*.ts",
    "server/**/*.ts",
    ".vitehub/types/**/*.d.ts"
  ]
}
```

## Production checks

- Public Env and `env.define` values are visible in built client code. Put secrets only in Server Env with `secret: true`.
- The generated `#vitehub/env/server` module is not blocked from client builds. Import it only from server-only entry points.
- Supply credentials through a source, not through literals or `default`. Static values and defaults can be serialized into the generated module.
- `SecretEnv` renders as `<redacted>` in string conversion, JSON, and Node inspection. This is type friction, not complete leak prevention. Unseal secrets as late as possible and do not return them in responses, logs, traces, or Agent output.
- Run `vitehub env check` in CI or before deploy.

## Connect Env to Agents

Env is not an Agent-facing Capability. Agents, Capabilities, and Channels read Server Env from server code. Do not pass secrets through Agent Invocation metadata or model-facing instructions.

- Built-in Agent Channels such as `telegram()` declare their credentials under `env.server.<channel>` when an Agent uses them. Read [Channel Env](/docs/agents/channels#channel-env) for the names and how to rename one.
- The [ask Driver](/docs/agents/agent-drivers#use-an-ask-driver) reads the `typesafe` group. Declare it with `typesafeEnv()`.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { typesafeEnv } from 'vite-hub/env'

export default defineConfig({
  env: {
    server: {
      typesafe: typesafeEnv({ provider: 'vercel' }),
    },
  },
})
```

| `provider` | `apiKey` source | `model` default |
| --- | --- | --- |
| `"typesafe"` (default) | Optional Secret Env `TYPESAFE_API_KEY`. The ask Driver reports an error when it is missing. | `jev-latest` |
| `"vercel"` | Optional Secret Env `AI_GATEWAY_API_KEY`. Without it, the client uses `VERCEL_OIDC_TOKEN` on Vercel. | `typesafe-ai/jev` |

`TYPESAFE_DEFAULT_MODEL` overrides the model at runtime. The `model` option changes the default.

## Next steps

- Replace credentials at runtime with [Env Bridge](/docs/server-primitives/env-bridge).
- Learn the server primitive model in [Server primitives](/docs/server-primitives#how-a-primitive-works-in-your-app).
- Use Env with [Auth](/docs/server-primitives/auth) when Auth runtime options need secrets.
- Check a stage from the [CLI](/docs/development/cli#check-server-env).
- Read the [Server Primitives overview](/docs/server-primitives).
