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

`seal()` encrypts and signs a JSON value for one purpose. It returns a compact, URL-safe string that the client can carry but cannot read or change. `unseal()` reads it back. Use it for upload tickets, signed links, review tokens, and OAuth state.

```ts [server/utils/uploads.ts]
import * as v from 'valibot'
import { seal, unseal } from 'vite-hub/env'

const Upload = v.object({ userId: v.string() })

export async function uploadUrl(userId: string) {
  const ticket = await seal('my-app:upload', { userId }, { ttl: 900 })
  return `/api/uploads/${ticket}`
}

export async function readTicket(ticket: string) {
  const [error, upload] = await unseal('my-app:upload', ticket, { schema: Upload })
  if (error) return undefined
  return upload
}
```

- **Purpose.** Each purpose has its own AES-GCM key, derived with `deriveSecret('vitehub:seal:<purpose>')`. A value sealed for `my-app:upload` does not open as `my-app:invite`.
- **`ttl`.** Seconds until the value expires. Without `ttl`, the value does not expire.
- **Value.** Any JSON value. Pass a [Standard Schema](https://standardschema.dev), such as a Valibot or Zod schema, as `schema` to check the value and get its type. Without `schema`, the value is `unknown`.
- **Hosts.** Web Crypto does the work, so a value sealed on Node opens on Cloudflare Workers, and the other way round. On Cloudflare, pass `{ event }` to read `VITEHUB_SECRET` from the bindings of that request.

`unseal()` returns `[error, undefined]` or `[undefined, value]`:

| Code | When |
| --- | --- |
| `ENV_SEAL_EXPIRED` | The `ttl` has passed. |
| `ENV_SEAL_INVALID` | The string is not a sealed value, someone changed it, or another root secret sealed it. |
| `ENV_SEAL_SCHEMA_MISMATCH` | The value opened, but it does not match `schema`. `error.cause` has the schema issues. |
| `ENV_SEAL_WRONG_PURPOSE` | The value was sealed for another purpose. |

A missing root secret is a configuration error, so `seal()` and `unseal()` throw `ENV_REQUIRED_MISSING`, as `deriveSecret()` does. A bad argument, such as an empty purpose, a `ttl` that is not a positive number, or a value that is not JSON, throws `ENV_SEAL_ARGUMENT_INVALID`.

`seal()` and `unseal()` from `vite-hub/env` read `VITEHUB_SECRET`. `#vitehub/env/server` exports the same two functions, and they also read the [development secret](#development) that ViteHub generates when it is not set.

### Sealed values that you store

A rotation of `VITEHUB_SECRET` makes every sealed value unreadable. That is correct for tokens that expire. For values that you store, such as provider credentials, pass a separate root secret of at least 32 characters, and pass the same one to `unseal()`:

```ts [server/utils/credentials.ts]
import * as v from 'valibot'
import { seal, unseal } from 'vite-hub/env'

const Credentials = v.object({ apiKey: v.string() })

// `secret` is a key that you rotate on its own, not with VITEHUB_SECRET.
export async function storeCredentials(apiKey: string, secret: string) {
  return await seal('my-app:credentials', { apiKey }, { secret })
}

export async function readCredentials(stored: string, secret: string) {
  const [error, credentials] = await unseal('my-app:credentials', stored, { schema: Credentials, secret })
  if (error) throw error
  return credentials
}
```

`secret` takes a string or a Secret Env value. Keep that key out of `VITEHUB_SECRET` rotation, and re-seal stored values when you change it.

## What ViteHub derives

| Purpose | Used by | Replaces |
| --- | --- | --- |
| `vitehub:seal:<purpose>` | The key of each [`seal()`](#seal-a-value) purpose | Hand-written AES-GCM keys |
| `vitehub:auth` | [Auth](/docs/auth/configure#secret) session signing when the app sets no Better Auth secret | `BETTER_AUTH_SECRET`, which still wins when it is set, as do `secret` and `secrets` in the Auth Definition |

## Development

When the Vite dev server starts without `VITEHUB_SECRET`, ViteHub generates one in `.vitehub/env/secret` (mode `0600`) for Server Env and Auth. It survives restarts, so you stay signed in. The first `deriveSecret()` call with a generated secret logs a warning.

Builds never generate a secret. Without `VITEHUB_SECRET`, a deployment fails at the first derivation, not at build.

## Rotation and storage

When you rotate `VITEHUB_SECRET`, every Auth session that uses the derived secret signs out, every dispatch key stops working, and every value from `seal()` without a `secret` option becomes unreadable.

Keys that encrypt stored data are separate, because changing them means encrypting the data again. Connections use `VITEHUB_CONNECTIONS_KEY`. The [Env Bridge](/docs/env/bridge) database store uses its own `encryptionKey`. Give `seal()` a separate `secret` for stored values for the same reason.

> [!WARNING]
> Anyone with the root secret can derive every secret above, including Auth session signing. Protect it as your most powerful credential. Give a CLI or CI job a derived key, such as the dispatch key, not the root secret.
