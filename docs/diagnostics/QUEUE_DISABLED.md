---
description: "Fix QUEUE_DISABLED in ViteHub. Queue is off in the generated server, because the Vite config sets queue false or the provider does not match the host."
seo.title: "QUEUE_DISABLED: Queue is turned off in this runtime"
---

`runQueue()`, `getQueue()`, `dynamicQueue`, or `vitehub queue list` throws `QUEUE_DISABLED`. The generated server has Queue turned off, so it sends no job.

## Why it happens

`hubQueue()` writes the Queue config into the generated Nitro plugin `.vitehub/nitro/queue/plugin.ts`. When that config is `false`, every Queue call throws this error before it looks up the Queue Definition. The config is `false` in two cases:

- The Vite config sets `queue: false`, or you pass `false` to `hubQueue()`. A top-level `queue` key replaces the options of `hubQueue()`.
- `queue.provider` names a provider that is not the host of the Nitro preset. For example, `provider: 'cloudflare'` with the Vercel preset. ViteHub then turns Queue off and does not report the conflict at build time.

`deferQueue()` does not throw. It logs the error and passes it to `onDispatchError`.

With `vitehub()`, this error does not occur. When `vitehub()` has no `queue: true`, Queue calls throw [`QUEUE_DEFINITION_NOT_FOUND`](/docs/queue/diagnostics/queue_definition_not_found) instead.

## Fix it

```diff [vite.config.ts]
 export default defineConfig({
   plugins: [hubQueue()],
-  queue: false,
 })
```

Remove `queue: false`. Without a `provider`, ViteHub selects the provider from the host: Cloudflare, Vercel, or `local` for a Node server.

```diff [vite.config.ts]
 export default defineConfig({
   plugins: [hubQueue()],
   nitro: { preset: 'vercel' },
-  queue: { provider: 'cloudflare' },
+  queue: { provider: 'vercel' },
 })
```

Make `queue.provider` match the Nitro preset, or remove `provider`. If you use `vitehub()`, enable Queue with `vitehub({ preset, queue: true })`. It sets the provider from the preset.

## Check the fix

Open `.vitehub/nitro/queue/plugin.ts` after `vite dev` or `vite build` starts. It must not contain `const queueConfig = false`. Then call the route that runs `runQueue()`. It returns `[error, result]` and does not throw `QUEUE_DISABLED`.

## Related

- [Queue configuration](/docs/queue/configure)
- [Queue limits and errors](/docs/queue/limits-and-errors)
- [Queue Server API](/docs/queue/server-api)
- [`QUEUE_DEFINITION_NOT_FOUND`](/docs/queue/diagnostics/queue_definition_not_found)
- [`QUEUE_MISSING_PROVIDER`](/docs/queue/diagnostics/queue_missing_provider)
