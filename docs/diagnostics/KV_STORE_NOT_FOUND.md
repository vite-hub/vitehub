---
description: "Fix KV_STORE_NOT_FOUND in ViteHub. kv.store(name) uses a store name that is not in kv.stores. Add the store or use a configured name."
seo.title: "KV_STORE_NOT_FOUND: unknown KV store"
---

An operation on `kv.store(name)` throws `KV_STORE_NOT_FOUND`. The KV config has no store with that name. `error.why` names the store.

## Why it happens

ViteHub reads the store names from the KV config. With `kv.stores`, each key is a store name. With a single store, such as `kv: true` or `kv: { driver: 'fs-lite' }`, the only name is `default`.

`kv.store(name)` does not check the name. The first operation on the handle, such as `get()` or `set()`, looks up the name and throws. The name must match a key of `kv.stores` exactly, with the same case.

The `vitehub kv` commands and the Console report the same code for `--store <name>`. Their message lists the configured stores.

## Fix it

```diff [vite.config.ts]
 export default defineConfig({
   plugins: [vitehub({
     host: 'node',
     kv: {
       stores: {
         default: { driver: 'fs-lite' },
+        sessions: { driver: 'fs-lite', base: '.vitehub/data/kv-sessions' },
       },
     },
   })],
 })
```

Add the store under `kv.stores`. A config with `stores` must also have a `default` store. Restart the dev server after you change the config.

```diff [server/utils/sessions.ts]
-const sessions = kv.store('session')
+const sessions = kv.store('sessions')
```

If the store exists, use its configured name.

## Check the fix

Start the dev server and run `vitehub kv list --store sessions` from another terminal. It lists the keys of the store. A wrong name prints `KV store "<name>" was not found` with the list of stores.

## Related

- [KV configuration](/docs/kv/configure#configuration-options)
- [Use KV at runtime](/docs/kv/server-api#use-it-at-runtime)
- [Read and write KV keys](/docs/cli/storage#read-and-write-kv-keys)
- [`KV_DISABLED`](/docs/kv/diagnostics/kv_disabled)
- [`KV_MISSING_DEFAULT_STORE`](/docs/kv/diagnostics/kv_missing_default_store)
