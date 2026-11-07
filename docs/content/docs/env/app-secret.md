---
title: App secret
navigation.title: App secret
description: Set one root secret and derive each signing secret from it.
navigation.order: 9
icon: i-lucide-key-square
---

`VITEHUB_SECRET` is your app's root secret. ViteHub features and your server code derive their secrets from it, so you set one value, not one per feature.

```bash [Terminal]
pnpm vitehub secret generate
```

Save the output as `VITEHUB_SECRET` on the host (`openssl rand -base64 32` also works). It needs at least 32 characters. Use a different one per deployment.

In a Nuxt app, ViteHub reads `NUXT_APP_SECRET` when `VITEHUB_SECRET` is not set. ViteHub uses its own salt, so its secrets never match the ones from Nuxt's `deriveSecret()`.

## Derive a secret

```ts [server/utils/session.ts]
import { deriveSecret } from '#vitehub/env/server'

export async function sessionPassword() {
  return await deriveSecret('my-app:session')
}
```

`deriveSecret(purpose)` returns 32 bytes as 64 hex characters. It uses HKDF-SHA256 with the salt `vitehub` and the purpose as `info`. Each purpose gets its own result, stable until the root secret changes. Name the purpose after its owner, for example `my-module:session`. ViteHub reserves the `vitehub:` prefix.

| Failure | Error code |
| --- | --- |
| `VITEHUB_SECRET` and `NUXT_APP_SECRET` are not set | `ENV_REQUIRED_MISSING` |
| The root secret is shorter than 32 characters | `ENV_RUNTIME_VALUE_INVALID` |

`vitehub secret derive <purpose>` prints the same value from `VITEHUB_SECRET` in your shell. It does not load the project.

```bash [Terminal]
VITEHUB_SECRET=... pnpm vitehub secret derive my-app:session
```

## What ViteHub derives

| Purpose | Used by | Replaces |
| --- | --- | --- |
| `vitehub:auth` | [Auth](/docs/auth/configure#secret) session signing when the app sets no Better Auth secret | `BETTER_AUTH_SECRET`, which still wins when it is set, as do `secret` and `secrets` in the Auth Definition |
| `vitehub:console-auth` | Inline [Console Auth](/docs/development/console) session signing | `BETTER_AUTH_SECRET`, which still wins when it is set |
| `vitehub:dispatch` | [Signed dispatch](/docs/development/cli#run-a-schedule-on-demand) from the CLI to a deployment | A pasted Console session cookie |

## Development

When the Vite dev server starts without `VITEHUB_SECRET` or `NUXT_APP_SECRET`, ViteHub generates one in `.vitehub/env/secret` (mode `0600`) for Server Env and inline Console Auth. It survives restarts, so you stay signed in. The first `deriveSecret()` call with a generated secret logs a warning.

Builds never generate a secret. Without `VITEHUB_SECRET`, a deployment fails at the first derivation, not at build.

## Rotation and storage

The root secret signs. It does not encrypt. When you rotate `VITEHUB_SECRET`, every Console session and every Auth session that uses the derived secret signs out, and every dispatch key stops working. Stored data stays readable.

Keys that encrypt stored data are separate, because changing them means encrypting the data again. Connections use `VITEHUB_CONNECTIONS_KEY`. The [Env Bridge](/docs/env/bridge) database store uses its own `encryptionKey`.

> [!WARNING]
> Anyone with the root secret can derive every secret above, including Console session signing. Protect it as your most powerful credential. Give a CLI or CI job a derived key, such as the dispatch key, not the root secret.
