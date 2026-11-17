---
title: App secret
navigation.title: App secret
description: Set one root secret for your app and derive each signing secret from it.
navigation.order: 9
icon: i-lucide-key-square
---

`VITEHUB_SECRET` is your app's root secret. ViteHub features and your server code derive their secrets from it, so you set one value, not one per feature.

```bash [Terminal]
pnpm vitehub secret generate
```

Save the output as `VITEHUB_SECRET` on the host (`openssl rand -base64 32` also works). It needs at least 32 characters. Use a different one per deployment.

ViteHub reads only `VITEHUB_SECRET`, not `NUXT_APP_SECRET`, so a Nuxt application sets `VITEHUB_SECRET` too. ViteHub derives with its own salt, so the same root never produces the same secret as Nuxt's `deriveSecret()`.

## Derive a secret

```ts [server/utils/session.ts]
import { deriveSecret } from 'vite-hub/env'

export async function sessionPassword() {
  return await deriveSecret('my-app:session')
}
```

`deriveSecret(purpose, { event, root })` returns 32 bytes as 64 hex characters. It uses HKDF-SHA256 with the salt `vitehub` and the purpose as `info`. The result is stable while the root secret is unchanged, and it is different for every purpose. Name the purpose after its owner, for example `my-module:session`. ViteHub reserves the `vitehub:` prefix.

Both options are optional. On Cloudflare, pass the request event, as in `deriveSecret('my-app:session', { event })`, so ViteHub reads `VITEHUB_SECRET` from the Worker bindings of that request. Pass `root` to derive from another root secret than `VITEHUB_SECRET`.

| Failure | Error code |
| --- | --- |
| `VITEHUB_SECRET` is not set | `ENV_REQUIRED_MISSING` |
| The root secret is shorter than 32 characters | `ENV_RUNTIME_VALUE_INVALID` |

`vitehub secret derive <purpose>` prints the same value from `VITEHUB_SECRET` in your shell. It does not load the project.

```bash [Terminal]
VITEHUB_SECRET=... pnpm vitehub secret derive my-app:session
```

## Seal a value

`seal()` encrypts and signs a JSON value for one purpose with a key from the root secret, and `unseal()` reads it back. Use it for upload tickets, page cursors, cookies, and single-use links. See [Sign and seal values](/docs/env/seal).

## What ViteHub derives

| Purpose | Used by | Replaces |
| --- | --- | --- |
| `vitehub:seal:<purpose>` | The key of each [`seal()`](/docs/env/seal) purpose | Hand-written AES-GCM keys |
| `vitehub:auth` | [Auth](/docs/auth/configure#secret) session signing when the app sets no Better Auth secret | `BETTER_AUTH_SECRET`, which still wins when it is set, as do `secret` and `secrets` in the Auth Definition |

## Development

When the Vite dev server starts without `VITEHUB_SECRET`, ViteHub generates one in `.vitehub/env/secret` (mode `0600`) for Server Env and Auth. It survives restarts, so you stay signed in. The first `deriveSecret()` call with a generated secret logs a warning.

Builds never generate a secret. Without `VITEHUB_SECRET`, a deployment fails at the first derivation, not at build.

## Rotation and storage

When you rotate `VITEHUB_SECRET`, every Auth session that uses the derived secret signs out, every dispatch key stops working, and every value from `seal()` without a `secret` option becomes unreadable.

Keys that encrypt stored data are separate, because changing them means encrypting the data again. Connections use `VITEHUB_CONNECTIONS_KEY`. The [Env Bridge](/docs/env/bridge) database store uses its own `encryptionKeys`. Give `seal()` a separate `secret` for stored values for the same reason.

> [!WARNING]
> Anyone with the root secret can derive every secret above, including Auth session signing. Protect it as your most powerful credential. Give a CLI or CI job a derived key, such as the dispatch key, not the root secret.
