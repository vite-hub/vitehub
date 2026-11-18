---
title: Sign and seal values
navigation.title: Sign and seal values
description: Put a value in a link, cookie, or page cursor that the client carries but cannot read or change, with a purpose and an expiry.
navigation.order: 10
icon: i-lucide-lock
---

An app often gives a value to the client that the client must send back unchanged: an upload ticket, a page cursor, an invite link, or a cookie. `seal()` encrypts and signs a JSON value for one purpose. It returns a short, URL-safe string. The client can carry the string, but it cannot read it or change it. `unseal()` checks the string and gives the value back.

```ts [server/utils/uploads.ts]
import * as v from 'valibot'
import { seal, unseal } from 'vite-hub/env'

const Upload = v.object({ userId: v.string() })

export async function uploadUrl(userId: string) {
  const ticket = await seal('my-app:upload', { userId }, { ttl: '15m' })
  return `/api/uploads/${ticket}`
}

export async function readTicket(ticket: string) {
  const [error, upload] = await unseal('my-app:upload', ticket, { schema: Upload })
  if (error) return undefined
  return upload
}
```

- **Purpose.** Each purpose has its own key, so a value sealed for `my-app:upload` does not open as `my-app:invite`. Name the purpose after its owner and its use. ViteHub reserves the `vitehub:` prefix.
- **`ttl`.** How long until the value expires: a duration such as `'15m'`, or a number of seconds. Without `ttl`, the value does not expire.
- **Value.** Any JSON value. Pass a [Standard Schema](https://standardschema.dev), such as a Valibot or Zod schema, as `schema` to check the value and get its type. Without `schema`, the value is `unknown`.
- **Key.** Each purpose key comes from the [app secret](/docs/env/app-secret), `VITEHUB_SECRET`, with `deriveSecret('vitehub:seal:<purpose>')`. You do not write or store a key.
- **Hosts.** Web Crypto (AES-GCM) does the work, so a value sealed on Node opens on Cloudflare Workers, and the other way round. On Cloudflare, pass `{ event }` so that ViteHub reads `VITEHUB_SECRET` from the bindings of that request.

`seal()` and `unseal()` from `vite-hub/env` read `VITEHUB_SECRET`. `#vitehub/env/server` exports the same two functions, and they also read the [development secret](/docs/env/app-secret#development) that ViteHub generates when it is not set.

## Page cursors

A cursor tells the next request where the last page stopped. Seal it, so that a client cannot change it to read rows that it must not see:

```ts [server/api/issues.get.ts]
import { defineEventHandler, getQuery, HTTPError } from 'h3'
import * as v from 'valibot'
import { seal, unseal } from 'vite-hub/env'

const Cursor = v.object({ after: v.number() })
const issues = Array.from({ length: 95 }, (_, index) => ({ id: index + 1, title: `Issue #${index + 1}` }))

export default defineEventHandler(async (event) => {
  const { cursor } = getQuery(event)
  let after = 0
  if (typeof cursor === 'string') {
    const [error, position] = await unseal('my-app:issues-cursor', cursor, { event, schema: Cursor })
    if (error) throw new HTTPError({ status: 400, message: error.why })
    after = position.after
  }
  const page = issues.filter(issue => issue.id > after).slice(0, 20)
  const last = page.at(-1)
  const next = last ? await seal('my-app:issues-cursor', { after: last.id }, { event, ttl: '1h' }) : undefined
  return { issues: page, next }
})
```

## Cookies

Seal the cookie value, so that a client cannot write its own cookie. This route unlocks a private diary with a PIN for one week:

```ts [server/api/unlock.post.ts]
import { defineEventHandler, HTTPError, readBody, setCookie } from 'h3'
import { seal } from 'vite-hub/env'

const week = 7 * 24 * 60 * 60

export default defineEventHandler(async (event) => {
  const body = await readBody<{ pin?: string }>(event)
  if (!body?.pin || body.pin !== process.env.DIARY_PIN) throw new HTTPError({ status: 401, message: 'Wrong PIN.' })
  const unlocked = await seal('my-app:diary', { unlockedAt: Date.now() }, { event, ttl: week })
  setCookie(event, 'diary', unlocked, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: week })
  return { unlocked: true }
})
```

```ts [server/middleware/diary.ts]
import { defineEventHandler, getCookie, HTTPError } from 'h3'
import { unseal } from 'vite-hub/env'

export default defineEventHandler(async (event) => {
  if (!event.url.pathname.startsWith('/api/diary')) return
  const [error] = await unseal('my-app:diary', getCookie(event, 'diary') ?? '', { event })
  if (error) throw new HTTPError({ status: 401, message: 'Unlock the diary first.' })
})
```

The `ttl` in the sealed value is the real limit. `maxAge` only tells the browser when to delete the cookie. For users, accounts, and sessions, use [Auth](/docs/auth).

## Single-use links

Pass `uses` and a `db` to make a link that opens once, or N times, and then is gone, such as an invite or an account recovery link. Pass the same `db` to `unseal()`:

```ts [server/api/share/[token].get.ts]
import { defineEventHandler, getRouterParam, HTTPError } from 'h3'
import { db } from 'vite-hub/database'
import { unseal } from 'vite-hub/env'

// Create the link elsewhere: await seal('my-app:share', { apiKey }, { uses: 1, ttl: '1h', db })
export default defineEventHandler(async (event) => {
  const [error, shared] = await unseal('my-app:share', getRouterParam(event, 'token')!, { db })
  if (error) throw new HTTPError({ status: 410, message: error.why })
  return shared
})
```

- **Atomic.** Each read takes one use with one conditional `UPDATE`. Of two reads of the last use, on any instances, one gets the value and the other gets `ENV_SEAL_USED_UP`.
- **No values in the database.** The token holds the encrypted value. The `vitehub_env_seal_uses` table holds only a random id, the uses left, and the expiry.
- **Database.** `db` is a SQLite, libSQL, or D1 Drizzle database, such as `db` from `vite-hub/database`. KV cannot take a use atomically, so it does not work here.
- **Failed reads keep their uses.** A value that does not open, has expired, or does not match `schema` keeps its uses. `unseal()` without `db` throws `ENV_SEAL_ARGUMENT_INVALID` for a value sealed with `uses`.

## Values that you store

Seal a field before you write it to the database, such as an API key that a user brings. Data that you keep must not depend on `VITEHUB_SECRET`, which you rotate with your sessions and links. For stored values, pass a separate root secret of at least 32 characters, and pass the same one to `unseal()`:

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

Store the result in a `text` column. `secret` takes a string, a Secret Env value, or a list of them for a rotation: the new secret first, then the old ones. `seal()` uses the first, and `unseal()` tries each in order.

## Expiry and rotation

- A value with `ttl` stops opening after that time and returns `ENV_SEAL_EXPIRED`. The expiry is inside the signed part, so a client cannot change it.
- To rotate `VITEHUB_SECRET`, set the new secret in `VITEHUB_SECRET` and the old one in `VITEHUB_SECRET_PREVIOUS`. `seal()` uses only `VITEHUB_SECRET`. `unseal()` tries `VITEHUB_SECRET`, then each old secret, so open links, cursors, and cookies keep working. When the longest `ttl` has passed, remove `VITEHUB_SECRET_PREVIOUS`. It holds one secret, or a comma-separated list.
- Without `VITEHUB_SECRET_PREVIOUS`, a value sealed with an old secret returns `ENV_SEAL_INVALID`.
- A value sealed with `secret` does not read `VITEHUB_SECRET` or `VITEHUB_SECRET_PREVIOUS`. To change `secret`, pass `[newSecret, oldSecret]` to `seal()` and `unseal()`, read each stored value and seal it again, then remove the old secret.

## Errors

`unseal()` returns `[error, undefined]` or `[undefined, value]`:

| Code | When |
| --- | --- |
| `ENV_SEAL_EXPIRED` | The `ttl` has passed. |
| `ENV_SEAL_INVALID` | The string is not a sealed value, someone changed it, or a root secret that is not in `VITEHUB_SECRET` or `VITEHUB_SECRET_PREVIOUS` sealed it. |
| `ENV_SEAL_SCHEMA_MISMATCH` | The value opened, but it does not match `schema`. `error.cause` has the schema issues. |
| `ENV_SEAL_USED_UP` | The value was sealed with `uses`, and every use is taken. |
| `ENV_SEAL_WRONG_PURPOSE` | The value was sealed for another purpose. |

A missing root secret is a configuration error, so `seal()` and `unseal()` throw `ENV_REQUIRED_MISSING`, as `deriveSecret()` does. A secret in `VITEHUB_SECRET_PREVIOUS` that is shorter than 32 characters throws `ENV_RUNTIME_VALUE_INVALID`. A bad argument, such as an empty purpose, a `ttl` that is not a positive number, or a value that is not JSON, throws `ENV_SEAL_ARGUMENT_INVALID`.

## When to use something else

| Task | Use |
| --- | --- |
| Give a client a short-lived link to a file in Blob | [`blob.sign()`](/docs/blob/server-api#signed-requests) |
| Check a webhook that Stripe or GitHub signed | [`verifyWebhook()`](/docs/env/webhooks) |
| Let a script or a CI runner call a route | [`requireServiceToken()`](/docs/env/service-tokens) |
| Sign users in and keep their sessions | [Auth](/docs/auth) |
| Get a key for your own HMAC or library | [`deriveSecret()`](/docs/env/app-secret#derive-a-secret) |
| Run a webhook or a request only once | [`withIdempotency()`](/docs/database/server-api#run-work-once-for-a-key) |
