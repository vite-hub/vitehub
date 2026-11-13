# @vite-hub/kv

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://comark-ui.onmax.me/badge.svg?label=ViteHub&amp;value=vitehub.dev"></a>
  <img alt="TypeScript" src="https://comark-ui.onmax.me/badge.svg?label=TypeScript&amp;value=ready">
  <img alt="Vite" src="https://comark-ui.onmax.me/badge.svg?label=Vite&amp;value=config">
  <img alt="KV" src="https://comark-ui.onmax.me/badge.svg?label=KV&amp;value=stores">
</p>

`@vite-hub/kv` gives server code one small-state API for settings, flags, cache entries, and JSON-like records.

## Install

```sh
pnpm add @vite-hub/kv
```

Add `@upstash/redis` when you use the Upstash driver. The `redis` driver uses `ioredis`, which KV installs.

## Minimal API

```ts
// server/api/settings.put.ts
import { kv } from "@vite-hub/kv"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  const [writeError] = await kv.set("settings", await readBody(event))
  if (writeError) throw writeError

  const [readError, settings] = await kv.get("settings")
  if (readError) throw readError
  return settings
})
```

```ts
// vite.config.ts
import { hubKV } from "@vite-hub/kv/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [hubKV({
    driver: "fs-lite",
    base: ".vitehub/data/kv",
  })],
})
```

## Vite Integration

Use `hubKV()` in Vite to resolve KV config and expose the `kv` runtime helper to server code.

An `fs-lite` store without `base` keeps the default store in `.vitehub/data/kv` and each named store in `.vitehub/data/kv-stores/<store>`, so named stores never share keys.

Providers include local `fs-lite`, Deno KV, [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted), Redis over TCP (`redis`), and a table in the app's Database (`database`). The storage layer is built on [unstorage](https://unstorage.unjs.io/guide).

## Shared stores on Node

Several Node processes share keys only through a shared store. Without a `driver`, a Node build picks:

1. `database` when the app has a Default Database on Postgres (the `@vite-hub/database` plugin with a `dialect: "postgresql"` Definition).
2. `fs-lite` in `.vitehub/data/kv` otherwise.

`{ driver: "redis", url?, base? }` reads `url` at runtime when it is `env:<NAME>`, and `env:REDIS_URL` is the default. A literal URL goes into the build output. `base` prefixes every key and defaults to `vitehub:kv:<store>`, so keys that are not ViteHub's stay apart. The generated store segment escapes `%`, `:`, `/`, `\`, and `?`; an empty store name uses `%`. This keeps store names separate after key normalization. Two ViteHub apps on one Redis database share the default, so give each app its own database or `base`. A Redis listing cursor holds its whole state, so another server process can read the next page.

`{ driver: "database", database? }` keeps keys in the table `vitehub_kv` of the Database `database` (default `"default"`), with one `namespace` per store. The store creates the table when it is missing; on Postgres, an advisory lock lets several servers start at once. Every atomic operation is one SQL statement, and expiry uses the clock of the Database. Writes start background cleanup of at most 1000 expired rows in their namespace. A full batch lets the next write start another batch; once a batch is not full, cleanup waits a minute. Postgres sweeps skip rows locked by another process. It works on Postgres and libSQL, not on D1.

The driver is selected at build time. Redis requires `kv: { driver: "redis" }`; every process must supply its URL, and a missing URL fails. An unrelated `REDIS_URL` never changes the selected driver. The `kv.list` operation (`vitehub kv list`, the Console) reports that driver.

This changes the default of a Node build with a Postgres Database from `fs-lite` to `database`. Keys in `.vitehub/data/kv` are not copied. Set `kv: { driver: "fs-lite" }` to keep the old store.

`fs-lite` writes each key as one file in `base`. The file name starts with `key-`, followed by the key with `%` and `:` escaped as in a URL, so `signups` and `signups:reset-at` are the files `key-signups` and `key-signups%3Areset-at`. This prefix keeps application keys separate from migration metadata and temporary files. Most file systems limit a file name to 255 bytes, so an escaped key longer than 251 bytes fails with `KV_OPERATION_FAILED`. Earlier versions wrote `a:b` as the file `a/b`. The store moves those files to their new names when it opens the folder and preserves literal `%` characters in old key names. It keeps a hidden layout record and metadata folder in `base`. The migration lock stays in that folder, so only `base` needs write access. Stop all processes that use the store before moving it. Copies and backups must preserve hidden files and hard links. Use GNU `cp -a` and verify the copied layout record before opening the copy; see [Move an fs-lite store](https://vitehub.dev/docs/kv/configure#move-an-fs-lite-store). Ordinary `cp -R` breaks the layout identity and can make existing keys inaccessible.

Deno KV accepts `kv.set(key, value, { ttl: seconds })` to expire a value. Omitting `ttl` keeps the value until it is deleted or replaced. Initialization failures do not disable a store for the life of the process. The next operation can retry initialization.

## Development stays local

In `vite dev` (and `nuxt dev`), a KV store is local unless it sets `remote: true`. When ViteHub infers the driver, Upstash env vars and the Vercel host do not select Upstash in development: the store is `fs-lite` in `.vitehub/data/kv`. On the Cloudflare host, a store uses the KV binding of the dev runtime when there is one, for example on the workerd runner. Without one, for example on Nitro's default Node runner, it uses `fs-lite` in `.vitehub/data/kv-cloudflare/<binding>` with the Workers KV limits.

`kv: { remote: true }` lets development infer the hosted store as a build does. On Cloudflare, ViteHub then writes `remote: true` on the generated Wrangler KV binding. The first operation prints `KV store "<name>" is remote`, and `vitehub inspect definitions --kind kv` shows `Development: Remote`. Writes change real data.

Development reads Upstash credentials from Vite's `.env` files for the current mode and `envDir`, with process environment values taking precedence. The credentials stay in the development server runtime.

An explicit `driver` is honored as before; an `upstash` store prints the same notice. Builds ignore `remote`. A `remote` value that is not a boolean fails with `KV_INVALID_REMOTE`. `remote: true` with `fs-lite` or `deno-kv`, `remote: false` with `upstash`, and `remote: true` in development without a hosted store fail with `KV_REMOTE_CONFLICT`.

## Nitro cache

`kvNitroCacheDriver` from `@vite-hub/kv/vite` is the file path of an unstorage driver over the default store, for Nitro's `cache` mount. Its keys get the `nitro-cache:` prefix, or the `base` option. With `vitehub()`, set `cache: { driver: "kv" }` to mount it.

## Listing keys

`kv.keys(prefix)` is exhaustive. Use `kv.list({ prefix, limit, cursor })` when the caller needs bounded work. `limit` must be a positive integer. A page returns `{ keys, cursor? }`; an omitted cursor means the listing is complete.

List prefixes use the same key normalization as reads and writes. For example, `users/al` matches the stored key `users:alice`. A trailing separator, such as `users/` or `users:`, limits the prefix to children and does not match `users-other`.

Cursors are opaque and provider-specific. Pass a returned cursor back to the same store with the same prefix. Cloudflare KV, Upstash, Deno KV, and `fs-lite` stop enumeration when the requested page is full. An `fs-lite` cursor retains a directory iterator in the current process for up to 15 minutes. Upstash uses the same retention window when the provider returns more keys than requested. These process-local cursors can expire sooner when more than 32 listings are left unfinished. Calling `disposeKVStores()` from the application shutdown hook releases these process-local cursors, closes retained directory iterators, and clears their expiry timers. A pending listing cannot retain a new cursor after disposal. Callers must restart listing without a cursor when continuation fails.

KV operations return `[error, value]`. `error.code` is one of the codes of the method, for example `KV_INVALID_CURSOR` for `list()`, and `error.why`, `error.fix`, and `error.docs` explain it. Provider failures use the code `KV_OPERATION_FAILED` and keep the provider failure in `cause`. A Cloudflare KV store checks the [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/) before it calls the binding, in production and in `vite dev`: a key above 512 bytes returns `KV_KEY_TOO_LONG`, a value above 25 MiB returns `KV_VALUE_TOO_LARGE`, `metadata` above 1024 bytes returns `KV_METADATA_TOO_LARGE`, and an `expirationTtl` below 60 seconds or an `expiration` less than 60 seconds in the future returns `KV_TTL_TOO_SHORT`. See [KV limits and errors](https://vitehub.dev/docs/kv/limits-and-errors). Configuration errors, for example an unknown named store, throw.

`kv.getMany(keys)` reads many keys in one call and returns one value or `null` per key, in the order of `keys`. `kv.setMany([{ key, value }], options)` writes many keys; the last entry of a key wins, and it is not atomic. Redis uses `MGET` and one pipeline, the `database` driver one statement per 200 keys, Upstash `MGET`, and Cloudflare KV one bulk `get()` per 100 keys. Other reads and writes run one key at a time, 16 at once. Cloudflare KV checks every entry against the Workers KV limits before it writes any.

`kv.setIfAbsent(key, value, { ttl })` writes the value only when the key has no value, in one atomic step. Its value is `true` for the one call that wrote it and `false` for the others. Use it for upload tickets, invite codes, and nonces instead of `get()` then `set()`, which two requests can race. Redis runs `SET NX` with `PX`, the `database` driver one `INSERT ... ON CONFLICT` that also replaces an expired key, and Upstash `SET NX`. Deno KV commits an atomic check that the key is missing; it deletes expired keys some time after the TTL. `fs-lite` creates the file exclusively, which is atomic on one disk, and never expires keys. Cloudflare KV returns `KV_UNSUPPORTED_OPERATION`, because Workers KV is eventually consistent; use D1 or a Durable Object there.

`redis`, `database`, and Upstash also support `kv.getAndDelete(key)`, `kv.increment(key, ttl)`, and `kv.deleteIfEquals(key, expected)`. These operations are atomic in the provider. `deleteIfEquals()` deletes the key only when its stored text equals `expected` serialized as `set()` stores it, and returns `true` when this call deleted it. Deno KV, Cloudflare KV, and `fs-lite` return `KV_UNSUPPORTED_OPERATION` because they cannot provide the same contract without extra storage or non-atomic calls. The type `KVDriverAtomicOperations` lists the atomic operations of each driver, and `KVDriversWith<"deleteIfEquals">` the drivers of one operation.

## Read-only handles

`kv.store(name, { mode: "read" })` returns a `ReadonlyKVStorage` handle with `get()`, `has()`, `keys()`, and `list()`. Write methods are a type error and absent at runtime. `mode` defaults to `"write"`, and another value throws `KV_INVALID_STORE_MODE`.

```ts
import { kv } from "@vite-hub/kv"

const flags = kv.store("default", { mode: "read" })
const [error, value] = await flags.get("flags")
```

The mode limits this API, not the host. The KV binding or provider token keeps full access, and code can still import the full `kv` export, so it is not a security boundary against code that reads the binding directly.

## Application teardown

Call `disposeKVStores()` from `@vite-hub/kv` (or `vite-hub/kv`) after stopping new application work. It disposes every initialized default and named store, waits for pending store initialization and cleanup, and reports cleanup failures with an `AggregateError`. Concurrent teardown calls share one promise. Later operations create fresh stores; old process-local cursors cannot resume.

For an explicit Redis store or an inferred Node store, `hubKV()` registers this cleanup on Nitro's `close` hook, so the Redis connection does not keep the process alive after a stop signal. For other stores, register the cleanup in a server plugin:

```ts fragment
// server/plugins/kv-cleanup.ts
import { disposeKVStores } from "@vite-hub/kv"

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("close", disposeKVStores)
})
```

## CLI

`hubKV()` contributes the `vitehub kv` CLI namespace: `list [--prefix] [--limit] [--cursor]`, `get <key>`, `has <key>`, `set <key> <value|@file> [--ttl <seconds>] [--json-value]`, and `delete <key>`. Each command accepts `--store <name>` and `--json`. `get` writes stored strings unchanged, without adding a newline. JSON input rejects underflow and decimal values that change magnitude during parsing; use strings to preserve them. Write commands print what they changed. There is no `clear` command.

Each command runs a `kv.*` operation of the app through the Console RPC. On the dev server it needs no sign-in. With `--url` it calls a deployed app. The same operations serve the Console KV page, which edits and deletes keys, and agents.

Learn more at [vitehub.dev](https://vitehub.dev).
