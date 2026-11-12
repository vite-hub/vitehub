---
description: "Fix QUEUE_DISABLED in ViteHub. Queue is off in this runtime, because the Vite config sets queue false or the provider does not match the host."
seo.title: "QUEUE_DISABLED: Queue is off in this runtime"
---

`sendQueue()`, `useQueue()`, `dynamicQueue`, or `vitehub queue list` throws `QUEUE_DISABLED`. The runtime has Queue turned off, so it sends no job.

## Why it happens

When the Queue config that the runtime installed is `false`, every Queue call throws this error before it looks up the Queue Definition. In Vitest, the generated test setup `.vitehub/queue/test-setup.mjs` installs the config. The config is `false` in two cases:

- An app that uses `@vite-hub/queue` alone passes `false` to `hubQueue()`.
- `queue.provider` names a provider that is not the host of the Nitro preset. For example, `provider: 'cloudflare'` with the Vercel preset. ViteHub then turns Queue off and does not report the conflict at build time.

In these two cases, a dev or built server registers no Queue runtime. Queue calls there throw [`QUEUE_DEFINITION_NOT_FOUND`](/docs/queue/diagnostics/queue_definition_not_found), not this error.

`deferQueue()` does not throw. It logs the error and passes it to `onDispatchError`.

With `vitehub()`, `queue: false` or no `queue` option adds no Queue runtime. Queue calls then throw [`QUEUE_DEFINITION_NOT_FOUND`](/docs/queue/diagnostics/queue_definition_not_found) instead.

## Fix it

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [hubQueue(false)],
+  plugins: [hubQueue()],
 })
```

Remove `false`. Without a `provider`, ViteHub selects the provider from the host: Cloudflare, Vercel, or `local` for a Node server.

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [hubQueue({ provider: 'cloudflare' })],
+  plugins: [hubQueue({ provider: 'vercel' })],
   nitro: { preset: 'vercel' },
 })
```

Make the `provider` of `hubQueue()` match the Nitro preset, or remove `provider`. If you use `vitehub()`, enable Queue with `vitehub({ preset, queue: true })`. It sets the provider from the preset.

## Check the fix

Run the Vitest test again, then open `.vitehub/queue/test-setup.mjs`. It must not contain `setQueueRuntimeConfig(false)`. The Queue call in the test returns `[error, result]` and does not throw `QUEUE_DISABLED`.

## Related

- [Queue configuration](/docs/queue/configure)
- [Queue limits and errors](/docs/queue/limits-and-errors)
- [Queue Server API](/docs/queue/server-api)
- [`QUEUE_DEFINITION_NOT_FOUND`](/docs/queue/diagnostics/queue_definition_not_found)
- [`QUEUE_MISSING_PROVIDER`](/docs/queue/diagnostics/queue_missing_provider)
