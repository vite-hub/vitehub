---
title: Env server API
description: Read Public Env and Server Env, load provider-backed values, and inspect Env status.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `env` from `@vite-hub/env` or `@vite-hub/env/vite` | Declare Env values and Env Sources. `env.boolean()`, `env.number()`, and `env.enum()` declare typed values. |
| `getViteHubErrorShape` from `@vite-hub/runtime` | Inspect operational Env failures by `ENV_*` code. |
| `hubEnv` from `@vite-hub/env/vite` | Register the Vite Integration. |
| `defineEnvProvider` from `@vite-hub/env` | Define a read-only runtime provider for external Env storage. |
| `loadServerEnv` from `#vitehub/env/server` | Load one immutable Server Env snapshot, including provider-backed values. |
| `describeServerEnv` from `#vitehub/env/server` | List declaration metadata without reading host values or calling providers. |
| `inspectServerEnv` from `#vitehub/env/server` | Inspect status-only Server Env metadata without returning values. |
| `isBlockingServerEnvEntry` from `@vite-hub/env` | Check whether an inspection entry makes `loadServerEnv()` fail. |
| `usePublicEnv` from `#vitehub/env/public` | Read generated Public Env from browser-safe code. |
| `useServerEnv` from `#vitehub/env/server` | Read generated Server Env from server code. |
| `deriveSecret` from `#vitehub/env/server` | Derive a purpose-specific secret from [`VITEHUB_SECRET`](/docs/env/app-secret). |
| `seal`, `unseal` from `vite-hub/env` | Encrypt and sign a JSON value for one purpose, with an optional `ttl`, and read it back as a `Result`. See [Seal a value](/docs/env/app-secret#seal-a-value). |
| `SecretEnv` from `@vite-hub/env` | Represent Secret Env values that redact by default. |
| `resolveServerEnv` from `@vite-hub/env` | Resolve a server env registry manually. |
| `openWorkflowEnv` from `@vite-hub/env` | Use the OpenWorkflow env preset. |
| `typesafeEnv` from `@vite-hub/env` | Declare the Server Env of the [`typesafe()` AI gateway](/docs/agents/ai-gateways), which [`driver.ask`](/docs/agents/agent-drivers#use-an-ask-driver), `llmGate()`, and `llmRoute()` use by default. |
| `parseSchema` from `@vite-hub/env` | Parse Standard Schema-compatible values. |

## Use it at runtime

Read Public Env in browser code. ViteHub generates the module behind this import. These examples read the values from [Configure Env](/docs/env/configure#configure-env).

```ts [src/config.ts] fragment
import { usePublicEnv } from '#vitehub/env/public'

export const appName = usePublicEnv().appName
```

Read Server Env in server code. A secret prints hidden. Call `unseal()` to get the string for an SDK or request.

```ts [server/github.ts] fragment
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

`useServerEnv()` checks every declared value, not only the ones you read. If a required value is missing, every call throws `ENV_REQUIRED_MISSING` with its path. If the app can run without a value, mark it `optional: true`, or give it a default. Defaults go into the generated server code, so never give a secret one. Run `vitehub env check` before a release to list missing values.

On Cloudflare, Server Env also reads Worker bindings. Pass the request event, as in `useServerEnv(event)`, to read the bindings in its [Standard Context](/docs/reference/runtime-context#standard-context). Without it, Server Env uses the active request. `loadServerEnv()`, `inspectServerEnv()`, `runWithServerEnv()`, and `deriveSecret()` take the same event.

## Read external Env storage

Use an Env provider when your credentials live outside the host environment. A provider connects to your store. It is not a ViteHub secret store. Your app picks the store, gives it a first credential through host Env, and sets its access rules.

Set the provider module and declare only the keys you use.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    env: {
      providers: {
        credentials: './server/env/credentials.ts',
      },
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
  plugins: [
    vitehub({
      preset: 'node',
      env: {
        providers: {
          credentials: './server/env/credentials.ts',
        },
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
    }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      env: {
        providers: {
          credentials: './server/env/credentials.ts',
        },
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
    }),
  ],
})
```
:::
::

The provider reads all keys once. It gets a frozen snapshot of literal and host values, so a Kubernetes or Cloudflare secret can sign in to the store without a circular import of `#vitehub/env/server`.

```ts [server/env/credentials.ts]
import { defineEnvProvider } from '@vite-hub/env'
import type { SecretEnv } from '@vite-hub/env'

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

Call `loadServerEnv()` at the start of each operation. Each call makes a new frozen snapshot, reads each key once, and caches nothing between loads. The next load sees a rotated value, while a running operation keeps its snapshot.

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

This GitHub token lets the app fetch Sources. It is not the model or shell credential, such as Codex auth or `GH_TOKEN` in an Agent workspace.

`useServerEnv()` stays synchronous for host and literal values, but throws `ENV_ASYNC_REQUIRED` for a provider field. `loadServerEnv()` and `runWithServerEnv()` load the full snapshot.

`describeServerEnv()` lists declarations without reading values or calling provider `read()`. Each entry has the path, [canonical variable name](/docs/env/configure#variable-names), source kind, provider alias, secret and required flags, whether a default exists, and the value type, such as `boolean` or `"draft" | "send"`. It leaves out defaults, conventional names, provider keys, and provider module paths. `inspectServerEnv()` entries also report `via` and `conflict`; see [Variable names](/docs/env/configure#variable-names).

The Console Env section shows this metadata behind Console access. With Env Bridge, a provider panel adds masked previews and runtime replacement, and admins see activity and manage grants per credential. The provider's own auth and permissions still apply. Host variables stay read-only.

`inspectServerEnv()` loads providers the same way. It reports only paths, source kinds, provider aliases, masking, required flags, and a status: `available`, `defaulted`, `missing`, `invalid`, or `error`. It never returns values, hashes, lengths, provider keys, or provider errors. Paths match `describeServerEnv()`. `isBlockingServerEnvEntry()` returns `true` when an entry makes `loadServerEnv()` fail: a missing required value, an invalid value, or a failed provider.

From the terminal, run `vitehub env inspect` or `vitehub env check`. `env check` exits with `1` for any blocking entry, so CI can run it before a release. Both load the stage's Vite env files and never print values. See [CLI](/docs/development/cli#inspect-server-env) for options. In the Console Env section, **Check status** shows the same.

Provider reads are read-only and get the caller's abort signal. [Env Bridge](/docs/env/bridge) adds safe replacement, scoped access, and stored activity for managed credentials. Env adds no watches, leases, or caches between requests. A provider must not import the generated Server Env module. Use the `env` snapshot that `read()` gets for its first credential.
