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
| `defineEnvProvider` from `@vite-hub/env/provider` | Define a read-only runtime provider for external Env storage. |
| `loadServerEnv` from `#vitehub/env/server` | Load one immutable Server Env snapshot, including provider-backed values. |
| `describeServerEnv` from `#vitehub/env/server` | List declaration metadata without reading host values or calling providers. |
| `inspectServerEnv` from `#vitehub/env/server` | Inspect status-only Server Env metadata without returning values. |
| `isBlockingServerEnvEntry` from `@vite-hub/env` | Check whether an inspection entry makes `loadServerEnv()` fail. |
| `usePublicEnv` from `#vitehub/env/public` | Read generated Public Env from browser-safe code. |
| `useServerEnv` from `#vitehub/env/server` | Read generated Server Env from server code. |
| `SecretEnv` from `@vite-hub/env` or `@vite-hub/env/secret` | Represent Secret Env values that redact by default. |
| `resolveServerEnv` from `@vite-hub/env` or `@vite-hub/env/server` | Resolve a server env registry manually. |
| `openWorkflowEnv` from `@vite-hub/env` or `@vite-hub/env/presets` | Use the OpenWorkflow env preset. |
| `typesafeEnv` from `@vite-hub/env` or `@vite-hub/env/presets` | Declare the TypeSafe Jev group for [`driver.ask`](/docs/agents/agent-drivers#use-an-ask-driver). |
| `parseSchema` from `@vite-hub/env` or `@vite-hub/env/schema` | Parse Standard Schema-compatible values. |

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

`describeServerEnv()` returns declaration paths, the [canonical variable name](/docs/env/configure#variable-names) of env declarations, source kinds, provider aliases, secret flags, required flags, whether a default exists, and the parsed value type such as `boolean` or `"draft" | "send"`. It never resolves values or calls provider `read()`. Use it for inventory. Default values, conventional variable names, provider keys, and provider module paths are omitted. `inspectServerEnv()` entries also report `via` and `conflict` for env values; see [Variable names](/docs/env/configure#variable-names). The Console Env section uses this metadata and inherits Console access protection. A provider with Env Bridge management also offers masked previews and runtime replacement in its detail panel. Administrators can view persisted activity and manage per-credential grants. These controls additionally enforce the provider's authentication and permissions; host variables stay read-only.

`inspectServerEnv()` uses the same provider load boundary and reports only declaration paths, source kinds, provider aliases, masking, required flags, and `available`, `defaulted`, `missing`, `invalid`, or `error` status. It never includes values, hashes, lengths, provider keys, or provider failure text. Paths match `describeServerEnv()`. `isBlockingServerEnvEntry()` returns `true` for an entry that makes `loadServerEnv()` fail: a required value is missing, a value is invalid, or a provider failed.

Check a stage from the terminal with `vitehub env inspect` or `vitehub env check`. `env check` exits with `1` for any blocking entry, so CI and deploy steps can run it before a release. Both commands load the stage's Vite env files and never print values. Read [CLI](/docs/development/cli#inspect-server-env) for options and output. The Console Env section shows the same status when you select **Check status**.

Provider reads are read-only and receive the caller's abort signal. For managed credentials, [Env Bridge](/docs/env/bridge) adds conditional replacement, scoped access, and durable activity. Env resolution does not add watches, leases, or cross-request caches. Providers must not import the generated Server Env module; use the local `env` snapshot passed to `read()` for bootstrap credentials.
