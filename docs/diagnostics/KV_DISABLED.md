---
description: "Fix KV_DISABLED in ViteHub. The generated KV config of the app is false, so the kv helper has no store. Enable KV in the config."
seo.title: "KV_DISABLED: KV is turned off in this runtime"
---

A `kv` call, such as `kv.get()`, throws `KV_DISABLED`. The runtime has a KV config, but that config turns KV off, so no store exists.

## Why it happens

The `kv` helper reads the generated module `#vitehub/kv/config`. When that module exports `kv: false`, the first operation throws. The module exports `false` when:

- An app that uses `@vite-hub/kv` alone passes `false` to `hubKv()`.
- A Nuxt app uses the `vite-hub/nuxt` module without `kv`. The module then writes a KV config with `kv: false`, because the Console and Agents bundle the KV operations in every app.

The `kv.*` operations behind the Console KV section and the `vitehub kv` commands also report `KV_DISABLED` when the app has no KV store.

`KV_DISABLED` is a configuration error. It throws, and it does not come back as `[error, value]`.

## Fix it

```diff [nuxt.config.ts]
 export default defineNuxtConfig({
   modules: ['vite-hub/nuxt'],
-  vitehub: { host: 'node' },
+  vitehub: { host: 'node', kv: true },
 })
```

`kv: true` turns KV on with the default driver of the host. Pass an object to select a driver or add named stores.

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [vitehub({ host: 'node' })],
+  plugins: [vitehub({ host: 'node', kv: true })],
 })
```

In a Vite app, set `kv` in `vitehub()` the same way, or set a store config such as `kv: { driver: 'fs-lite' }`. With `@vite-hub/kv` alone, call `hubKv()` without `false`.

## Check the fix

Restart the dev server. Then run `vitehub kv list` from another terminal. It lists the keys of the default store and does not report `KV_DISABLED`. Call the route that uses `kv` to check the app code.

## Related

- [KV configuration](/docs/kv/configure)
- [Enable KV](/docs/kv/get-started#enable-kv)
- [KV limits and errors](/docs/kv/limits-and-errors)
- [Read and write KV keys](/docs/development/cli#read-and-write-kv-keys)
- [`KV_STORE_NOT_FOUND`](/docs/kv/diagnostics/kv_store_not_found)
- [`KV_INVALID_CONFIG`](/docs/kv/diagnostics/kv_invalid_config)
