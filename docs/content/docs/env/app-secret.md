---
title: App secret
navigation.title: App secret
description: Configure one root secret and derive every purpose-specific signing secret from it.
navigation.order: 9
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

`seal()` and `unseal()` from `vite-hub/env` read `VITEHUB_SECRET` or `NUXT_APP_SECRET`. `#vitehub/env/server` exports the same two functions, and they also read the [development secret](#development) that ViteHub generates when neither is set.

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
| `vitehub:console-auth` | Inline [Console Auth](/docs/development/console) session signing | `BETTER_AUTH_SECRET`, which still wins when it is set |
| `vitehub:dispatch` | [Signed dispatch](/docs/development/cli#run-a-schedule-on-demand) from the CLI to a deployment | A pasted Console session cookie |

## Development

When the Vite development server starts without `VITEHUB_SECRET` or `NUXT_APP_SECRET`, ViteHub generates one, saves it in `.vitehub/env/secret` with mode `0600`, and supplies it to that project’s Server Env runtime and inline Console Auth. The saved secret survives restarts, so development sessions stay signed in. The first `deriveSecret()` call with a generated secret logs a warning.

Builds never generate a secret. A deployment without `VITEHUB_SECRET` fails at the first derivation, not at build time.

## Rotation and storage

The root secret signs and authenticates. Do not use it to encrypt stored data. Rotating `VITEHUB_SECRET` signs out every Console session and every Auth session that uses the derived secret, invalidates every dispatch key, and makes every value from `seal()` without a `secret` option unreadable.

Keys that encrypt data at rest stay separate, because changing them requires re-encrypting stored values: Connections use `VITEHUB_CONNECTIONS_KEY`, and the [Env Bridge](/docs/env/bridge) database store uses its own `encryptionKey`. Give `seal()` a separate `secret` for the same reason.

Anyone with the root secret can derive every secret above, including Console session signing. Treat it like the most privileged credential of the deployment. Give a CLI or CI job a derived key, such as the dispatch key, instead of the root secret.
