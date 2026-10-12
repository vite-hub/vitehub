---
title: App secret
navigation.title: App secret
description: Configure one root secret and derive every purpose-specific signing secret from it.
navigation.order: 6
icon: i-lucide-key-square
---

`VITEHUB_SECRET` is the root secret of an application. ViteHub features and your own server code derive the secrets they need from it, so a deployment configures one value instead of one value per feature.

```bash [Terminal]
pnpm vitehub secret generate
```

Store the printed value as `VITEHUB_SECRET` in the host environment of each deployment. `openssl rand -base64 32` produces an equivalent value. The secret must be at least 32 characters. Use a different root secret for each deployment.

In a Nuxt application, ViteHub reads `NUXT_APP_SECRET` when `VITEHUB_SECRET` is not set. ViteHub derives with its own salt, so the same root never produces the same secret as Nuxt's `deriveSecret()`.

## Derive a secret

```ts [server/utils/session.ts]
import { deriveSecret } from '#vitehub/env/server'

export async function sessionPassword() {
  return await deriveSecret('my-app:session')
}
```

`deriveSecret(purpose)` returns 32 bytes as 64 hex characters. It uses HKDF-SHA256 with the salt `vitehub` and the purpose as `info`. The result is stable while the root secret is unchanged, and it is different for every purpose. Name the purpose after its owner, for example `my-module:session`. ViteHub reserves the `vitehub:` prefix.

| Failure | Error code |
| --- | --- |
| `VITEHUB_SECRET` and `NUXT_APP_SECRET` are not set | `ENV_REQUIRED_MISSING` |
| The root secret is shorter than 32 characters | `ENV_RUNTIME_VALUE_INVALID` |

`vitehub secret derive <purpose>` prints the same value from the `VITEHUB_SECRET` in the shell environment. It does not load the project.

```bash [Terminal]
VITEHUB_SECRET=... pnpm vitehub secret derive my-app:session
```

## What ViteHub derives

| Purpose | Used by | Replaces |
| --- | --- | --- |
| `vitehub:console-auth` | Inline [Console Auth](/docs/development/console) session signing | `BETTER_AUTH_SECRET`, which still wins when it is set |

## Development

When the Vite development server starts without `VITEHUB_SECRET` or `NUXT_APP_SECRET`, ViteHub generates one, saves it in `.vitehub/env/secret` with mode `0600`, and sets `VITEHUB_SECRET` for the server process. The saved secret survives restarts, so development sessions stay signed in. The first `deriveSecret()` call with a generated secret logs a warning.

Builds never generate a secret. A deployment without `VITEHUB_SECRET` fails at the first derivation, not at build time.

## Rotation and storage

The root secret signs and authenticates. It does not encrypt stored data. Rotating `VITEHUB_SECRET` signs out every Console session and changes every derived secret, and nothing stored becomes unreadable.

Keys that encrypt data at rest stay separate, because changing them requires re-encrypting stored values: Connections use `VITEHUB_CONNECTIONS_KEY`, and the [Env Bridge](/docs/env/bridge) database store uses its own `encryptionKey`.

Anyone with the root secret can derive every secret above, including Console session signing. Treat it like the most privileged credential of the deployment. Give a CLI or CI job a derived secret instead of the root secret.
