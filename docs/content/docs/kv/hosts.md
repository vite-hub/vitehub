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

The commands call the same KV storage as the running app. Pass `--store <name>` for a named store. Each write command prints what it changed. There is no `clear` command. The commands call a guarded endpoint that exists only on the Vite Development Server. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 there. Read [CLI](/docs/development/cli#read-and-write-kv-keys) for every command and option.

KV inspection represents `bigint` values, including nested values, as decimal strings. Values that cannot be serialized return `KV_VALUE_UNSUPPORTED`. Cloudflare write results report the effective TTL after rounding.

## Production checks

KV prefixes are conventions, not relational models. Move data to Database when you need constraints, joins, migrations, history, or complex queries.

Do not build coordination locks on top of basic `kv.get()` and `kv.set()`. The atomic methods cover single-use reads and counters; they are not a general compare-and-swap API.
