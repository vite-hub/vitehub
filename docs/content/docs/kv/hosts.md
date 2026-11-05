---
title: KV hosts
description: Keep KV code portable across providers, read keys during development, and know production limits.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Provider output

The KV package selects the default or named store and generates store-name types. Put provider namespaces, bindings, and credentials in integration configuration or deployment setup.

Application code keeps importing `kv` from `@vite-hub/kv` when you switch between local, Cloudflare, Deno, Vercel-compatible, or other drivers.

## Read and write keys during development

`hubKv()` contributes the `vitehub kv` CLI namespace. Start the Vite Development Server, then read and write keys from another terminal.

```bash [Terminal]
pnpm vitehub kv list --prefix users:
pnpm vitehub kv get settings --json
pnpm vitehub kv set settings '{"theme":"dark"}' --json-value
pnpm vitehub kv del settings
```

The commands call the same KV storage as the running app. Pass `--store <name>` for a named store. Each write command prints what it changed. There is no `clear` command. The commands run the `kv.*` [operations](/docs/development/operations) of the app, on the dev server of this project or, with `--url`, on a deployed app that enables the [Console](/docs/development/console). The operations run in the Nitro runtime, which owns the stores. `kv set` and `kv del` refuse keys that start with `vitehub:` (`KV_RESERVED_KEY`), because ViteHub keeps its own state there; reads stay open. Read [CLI](/docs/development/cli#read-and-write-kv-keys) for every command and option.

KV inspection represents `bigint` values, including nested values, as decimal strings. Values that cannot be serialized return `KV_VALUE_UNSUPPORTED`. Cloudflare write results report the effective TTL after rounding. The drivers cannot report how long a key has left, so `kv get` reports `expiry: "unknown"` (or `"none"` for `fs-lite`, which never expires keys). A write without `--ttl` removes an existing expiry, and the Console editor warns about it and has an **Expires in seconds** field.

## Production checks

KV prefixes are conventions, not relational models. Move data to Database when you need constraints, joins, migrations, history, or complex queries.

Do not build coordination locks on top of basic `kv.get()` and `kv.set()`. The atomic methods cover single-use reads, single-use writes with `setIfAbsent()`, and counters; they are not a general compare-and-swap API.

## Related guides

Use [Upstash Redis for ViteHub KV](/docs/guides/upstash-redis) for hosted REST
configuration and a persistence check.
