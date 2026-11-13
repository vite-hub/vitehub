---
description: "Fix QUEUE_DEFINITION_NOT_FOUND in ViteHub. The queue name has no discovered Queue Definition, or the app runs without Queue enabled."
seo.title: "QUEUE_DEFINITION_NOT_FOUND: unknown Queue name"
---

`sendQueue()`, `useQueue()`, or `dynamicQueue` throws `QUEUE_DEFINITION_NOT_FOUND` when the runtime has no Queue Definition with the name that you passed. `error.why` shows the name only when it is a safe identifier.

## Why it happens

The generated server output loads a registry of the discovered Queue Definitions. ViteHub looks up the name in that registry. The lookup fails when:

- No file defines the name. ViteHub discovers `server/queues/<name>.ts` and `src/<name>.queue.ts`. The file path gives the name, so `server/queues/welcome-email.ts` is `welcome-email`.
- The file has no default export of `defineQueue()`. A named export is not a Queue Definition.
- Queue is not enabled. Without `queue: true` in `vitehub()`, ViteHub generates no registry, so every name is unknown.
- The code runs outside of the generated server output, for example a script that you start with plain `node`. Only the server output loads the registry.
- The local provider runs a stored job, but you renamed or deleted its Queue Definition. The job becomes a dead job.
- The Cloudflare Worker receives a batch from a queue that maps to no Queue Definition of this build.

## Fix it

```diff [server/api/signup.post.ts]
 import { sendQueue } from 'vite-hub/queue'

 export default defineEventHandler(async () => {
-  const [error] = await sendQueue('welcome', { email: 'ava@example.com' })
+  const [error] = await sendQueue('welcome-email', { email: 'ava@example.com' })
   if (error) throw error
 })
```

Use the name that discovery gives the file. Here the file is `server/queues/welcome-email.ts`, and it has `export default defineQueue(...)`.

```diff [vite.config.ts]
 export default defineConfig({
-  plugins: [vitehub({ host: 'cloudflare' })],
+  plugins: [vitehub({ host: 'cloudflare', queue: true })],
 })
```

Enable Queue when the Queue Definition exists but every name fails. Restart `vite dev`, or build again, so the server output loads the registry.

For a dead local job of a deleted Queue Definition, run `vitehub queue jobs clear --state dead`.

## Check the fix

Run `vitehub inspect definitions --kind queue`. It lists each discovered Queue Definition with its name and file. If it prints `Unknown Definition kind: queue`, Queue is not enabled. Then start `vite dev` and call the route again.

## Related

- [Define a queue](/docs/queue/configure#define-a-queue)
- [Queue Server API](/docs/queue/server-api)
- [Inspect Definitions and Provider Output](/docs/development/cli#inspect-definitions-and-provider-output)
- [Local delivery](/docs/queue/limits-and-errors#local-delivery)
- [`QUEUE_DISABLED`](/docs/queue/diagnostics/queue_disabled)
- [`QUEUE_DEFINITION_LOAD_FAILED`](/docs/queue/diagnostics/queue_definition_load_failed)
