---
description: "Fix QUEUE_MISSING_REGION in ViteHub. The installed @vercel/queue needs a region. Set queue.region or the QUEUE_REGION environment variable."
seo.title: "QUEUE_MISSING_REGION: set a Vercel Queue region"
---

A Vercel Queue client throws `QUEUE_MISSING_REGION` when it starts. The installed `@vercel/queue` needs a region, and ViteHub cannot find one.

## Why it happens

When the installed `@vercel/queue` exports a `QueueClient` class, ViteHub must pass it a region. ViteHub looks for the region in this order:

1. `queue.region` in `vitehub()`, `region` in `hubQueue()`, or `region` in `createQueueClient()`.
2. The `QUEUE_REGION` environment variable.
3. The `VERCEL_REGION` environment variable.
4. The current Vercel request: the `ce-vqsregion` header, or the region prefix of the `x-vercel-id` header.

If all four are empty, the client throws. This occurs when the Vercel provider runs outside of a Vercel request and without these variables. Examples are a script, a test, or the Vercel build output that you run on your own machine.

`sendQueue()` and `useQueue()` in `vite dev` use the local provider, so they do not throw this error. A direct Vercel client from `createQueueClient()` can still throw it there. A client that you pass as `client` to `createQueueClient()` does not need a region.

## Fix it

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [vitehub({ host: 'vercel', queue: true })],
+  plugins: [vitehub({ host: 'vercel', queue: { provider: 'vercel', region: 'iad1' } })],
 })
```

`queue.region` sets the default region for each Vercel Queue client. Use the region of your Vercel Queues. You can set `QUEUE_REGION=iad1` in the server environment instead, so that the value is not in the build.

```diff [server/send-report.ts]
 await createQueueClient({
   provider: 'vercel',
   topic: 'topic--77656c636f6d65',
+  region: 'iad1',
 })
```

A direct client from `createQueueClient()` does not read `queue.region` from `vitehub()`. Pass `region`, or set `QUEUE_REGION`.

## Check the fix

Build again, deploy, and call the route that runs `sendQueue()`. The client starts, and the result has no `QUEUE_MISSING_REGION` error. For a script, run it with `QUEUE_REGION` set and check that `createQueueClient()` resolves.

## Related

- [Vercel region and topics](/docs/queue/configure#vercel-region-and-topics)
- [Queue configuration](/docs/queue/configure)
- [Queue Server API](/docs/queue/server-api)
- [Queue limits and errors](/docs/queue/limits-and-errors)
- [`QUEUE_VERCEL_SDK_UNAVAILABLE`](/docs/queue/diagnostics/queue_vercel_sdk_unavailable)
