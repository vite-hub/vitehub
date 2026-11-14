---
title: KV hosts
description: Keep KV code the same on every provider, read keys during development, and know the production limits.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider output

KV picks the store and generates store-name types. Put namespaces, bindings, and credentials in your config or deployment. Your code imports `kv` from `vite-hub/kv` on every driver (local, Cloudflare, Deno, Vercel, or others).

`vite dev` keeps every store local unless it sets `remote: true`, also when `.env` has Upstash credentials. Read [Development stays local](/docs/kv/configure#development-stays-local).

## Read and write keys during development

`hubKV()` adds `vitehub kv` commands. Start the Vite dev server, then use them from another terminal.

```bash [Terminal]
pnpm vitehub kv list --prefix users:
pnpm vitehub kv get settings --json
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv delete settings
```

- They run the app's `kv.*` [operations](/docs/console/operations) in the Nitro runtime, on the same storage. They target the dev server or, with `--url`, a deployed app with the [Console](/docs/console) on. `--store <name>` picks a named store.
- Each write prints what it changed. There is no `clear` command.
- `kv set` and `kv delete` refuse `vitehub:` keys (`KV_RESERVED_KEY`), where ViteHub keeps its state. Reads work.

Read [CLI](/docs/development/cli#read-and-write-kv-keys) for every command and option.

- `bigint` values, also nested, show as decimal strings. Values that cannot be serialized return `KV_VALUE_UNSUPPORTED`.
- Cloudflare writes report the TTL after rounding.
- Drivers cannot tell a key's time left, so `kv get` shows `expiry: "unknown"`.
- A write without `--ttl` removes the old expiry. The Console editor warns and has an **Expires in seconds** field.

## Preview deployments

::warning
A Cloudflare Version URL reads and writes production keys ([Compare workflows](https://developers.cloudflare.com/workers/previews/compare-workflows/)).
::

A Cloudflare Preview uses only the bindings in the Wrangler `previews` block, and Previews that bind the same namespace `id` share data ([Resources and isolation](https://developers.cloudflare.com/workers/previews/resources/)). ViteHub does not write that block. Declare a namespace in `previews.kv_namespaces` yourself.

To give a preview Worker its own namespace:

- Set `KV_NAMESPACE_ID` in its build and leave `namespaceId` unset.
- Set `namespaceId` to the preview id. It wins over `KV_NAMESPACE_ID`.
- Set a separate `namespaceName`, leave `namespaceId` and `KV_NAMESPACE_ID` unset, and provision it before the build.

Read [Preview deployments share data](/docs/development/provisioning#preview-deployments-share-data).

## Production checks

Key prefixes are not tables. Use Database for constraints, joins, migrations, history, or complex queries.

Do not build locks with `kv.get()` and `kv.set()`. The atomic methods cover single-use reads, single-use writes with `setIfAbsent()`, owner-only deletes with `deleteIfEquals()`, and counters; they are not a general compare-and-swap API.

## Related guides

Read [Upstash Redis for ViteHub KV](/docs/guides/upstash-redis) for hosted setup and a persistence check.
