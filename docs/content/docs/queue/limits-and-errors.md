---
title: Queue limits and errors
description: Handle Queue errors by code, repair Queue configuration errors, and check delivery guarantees before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Queue errors

`runQueue()`, `dynamicQueue.run()`, `send()`, and `sendBatch()` return `[error, result]`. When `error` is set, `error.code` names the failure, `error.why` tells what went wrong, `error.fix` tells what to do, and `error.docs` links to the code on this page. `error.cause` keeps the provider error.

```ts [server/api/signup.post.ts]
import { runQueue } from '@vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  const [error, result] = await runQueue('welcome-email', { email: body.email })
  if (error) {
    console.error(error.code, error.why, error.cause)
    throw error
  }
  return result
})
```

The type of `error.code` is the union of the codes that the method can return. `runQueue()` can return `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, or `QUEUE_UNSUPPORTED_OPTION`. A Cloudflare `send()` cannot return `QUEUE_PROVIDER_INVALID_RESPONSE`.

`JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`. It does not include `cause` or `stack`, because provider errors can contain credentials or private data. Log `cause` only on the server.

Configuration errors throw instead. They mean that the code or the deployment must change, so a retry cannot help. Examples are an unknown Queue name and a missing Cloudflare binding. `getQueue()` and `createQueueClient()` also throw these errors, because they only prepare a client. `deferQueue()` does not return a result: it logs a failure and passes it to `onDispatchError`.

| Code | Returned by | Thrown |
| --- | --- | --- |
| `QUEUE_PROVIDER_FAILED` | Every send method | `getQueue()`, when the client cannot start |
| `QUEUE_PROVIDER_INVALID_RESPONSE` | Vercel `send()`, `runQueue()` | |
| `QUEUE_UNSUPPORTED_OPTION` | Every send method | |
| `QUEUE_BINDING_NOT_FOUND`, `QUEUE_DEFINITION_LOAD_FAILED`, `QUEUE_DEFINITION_NOT_FOUND`, `QUEUE_DISABLED`, `QUEUE_INVALID_BINDING`, `QUEUE_MISSING_QUEUE`, `QUEUE_MISSING_REGION`, `QUEUE_MISSING_TOPIC`, `QUEUE_PROVIDER_MISMATCH`, `QUEUE_RUNTIME_NOT_INSTALLED`, `QUEUE_VERCEL_SDK_INVALID`, `QUEUE_VERCEL_SDK_UNAVAILABLE` | | When an operation starts |
| `QUEUE_BINDING_CONFLICT`, `QUEUE_CRYPTO_UNAVAILABLE`, `QUEUE_DEFINITIONS_CHANGED`, `QUEUE_INVALID_CONFIG`, `QUEUE_INVALID_DEFINITION`, `QUEUE_INVALID_NAME`, `QUEUE_INVALID_PROVIDER`, `QUEUE_MISSING_PROVIDER`, `QUEUE_NAME_COLLISION`, `QUEUE_PLUGIN_INCOMPATIBLE`, `QUEUE_PROVISION_FAILED` | | At define time, when Vite reads the config, or during the build |

### Errors in a Queue handler

A handler can throw. Queue Delivery logs the error and lets the provider retry it, except for Queue errors that a retry cannot fix. Cloudflare acknowledges those, Vercel acknowledges them when `callbackOptions.retry` returns `undefined`, and the local provider keeps them as dead jobs. `QUEUE_PROVIDER_FAILED` and `QUEUE_PROVIDER_INVALID_RESPONSE` retry; every other Queue code is acknowledged. Use `onError` or `callbackOptions.retry` to choose another action on Cloudflare or Vercel. The local provider does not call them. See [Local delivery](#local-delivery).

Throw `ViteHubError` from `@vite-hub/runtime` when the handler needs a stable application code. Its code does not change the retry policy.

```ts
new ViteHubError('WELCOME_EMAIL_REJECTED', 'Welcome email was rejected.', {
  cause,
  details: { campaign: 'welcome' },
})
```

## Runtime errors

### QUEUE_PROVIDER_FAILED

The provider rejected a send, a batch send, or the start of a client. `error.why` names the provider and the operation. Read `error.cause` for the provider error. A retry can help when the provider is available again. On Vercel, pass `idempotencyKey` so that a retry does not enqueue the job two times.

### QUEUE_PROVIDER_INVALID_RESPONSE

Vercel accepted the job for deferred processing when its response has `messageId: null`; `result.messageId` is then `undefined`. A response with a missing or invalid `messageId` is an error. The job can be in the queue, so do not send it again without an `idempotencyKey`. Check the installed `@vercel/queue` version.

### QUEUE_UNSUPPORTED_OPTION

The provider does not support an enqueue option. Cloudflare does not support `idempotencyKey`, `region`, or `retentionSeconds`. Vercel does not support `contentType`. The local provider does not support `contentType`, `region`, or `retentionSeconds`. See [Queue Enqueue options](/docs/queue/server-api#queue-enqueue-options).

## Configuration errors

### QUEUE_BINDING_NOT_FOUND

The Cloudflare client has no binding, or the request env does not have the generated binding. `error.why` names the binding when it is a valid identifier. Run the Worker that `vite build` writes, with `wrangler dev` or a deployment, so its configuration has the generated binding. A custom Worker configuration must keep that binding. The Vite and Nuxt dev servers run Queue jobs with the local provider and need no binding, but a direct Cloudflare client from `createQueueClient()` still needs one there.

### QUEUE_DEFINITION_LOAD_FAILED

A discovered Queue Definition module threw when it loaded. Read `error.cause` for the import error.

### QUEUE_DEFINITION_NOT_FOUND

No discovered Queue Definition has the requested name, or a Cloudflare queue does not map to a Queue Definition. `error.why` names the queue only when the name is a safe identifier. The generated server output loads the Queue Definitions, so a script that runs outside of it, or an app built without Queue, finds none. When the Vite config sets `queue: false`, `runQueue()` reports [`QUEUE_DISABLED`](#queue_disabled) instead.

### QUEUE_DISABLED

The Vite config sets `queue: false`, or Queue is not configured in this runtime.

### QUEUE_INVALID_BINDING

The Cloudflare binding does not have `send()` and `sendBatch()`. Pass a Queue producer binding.

### QUEUE_MISSING_QUEUE

A direct local client from `createQueueClient({ provider: 'local' })` needs a `queue`, the name of the Queue Definition that runs the jobs. `getQueue()` sets it for discovered Queue Definitions.

### QUEUE_MISSING_REGION

The installed `@vercel/queue` needs a region. ViteHub reads `queue.region`, then `QUEUE_REGION`, then `VERCEL_REGION`, then the region of the current Vercel request. Set one of them.

### QUEUE_MISSING_TOPIC

A direct Vercel client from `createQueueClient()` needs a `topic`. `getQueue()` sets the topic for discovered Queue Definitions.

### QUEUE_PROVIDER_MISMATCH

The generated Cloudflare, Vercel, or local runtime received another provider. Set `queue.provider` to the provider of the deployment preset, and build again.

### QUEUE_RUNTIME_NOT_INSTALLED

The Queue runtime has no client factory. The generated server output installs it. Add `hubQueue()` to the Vite config, build the app, and run the built server.

### QUEUE_VERCEL_SDK_INVALID

`@vercel/queue`, or the `client` that you passed, does not have `send()` and `handleCallback()`. Install a supported `@vercel/queue` version.

### QUEUE_VERCEL_SDK_UNAVAILABLE

`@vercel/queue` cannot be loaded. Add it to the app dependencies. Read `error.cause` for the import error.

## Definition and build errors

### QUEUE_BINDING_CONFLICT

A custom `queue.binding` works with one Queue Definition only. Remove `queue.binding`, so that each Queue Definition gets its own generated binding.

### QUEUE_CRYPTO_UNAVAILABLE

A long Queue Definition name gets a hashed Cloudflare queue name, and the hash needs `node:crypto`. Enable the `nodejs_compat` compatibility flag, or use a shorter name.

### QUEUE_DEFINITIONS_CHANGED

Queue Definition files changed after Vite resolved the config. Generate those files before the Vite config resolves.

### QUEUE_INVALID_CONFIG

`queue` is not a plain object or `false`.

### QUEUE_INVALID_DEFINITION

`defineQueue()` received no handler function.

### QUEUE_INVALID_NAME

The derived Cloudflare queue name contains characters that Cloudflare does not accept. Change `queue.namePrefix` so that it contains only letters, numbers, and dashes.

### QUEUE_INVALID_PROVIDER

`queue.provider` is not `cloudflare`, `vercel`, or `local`.

### QUEUE_MISSING_PROVIDER

ViteHub cannot select a provider for the hosting target, for example Netlify or Deno. Set `queue.provider`, select the Cloudflare, Vercel, or Node deployment preset, or set `queue: false`.

### QUEUE_NAME_COLLISION

Two Queue Definitions get the same Cloudflare queue name or the same Vercel route. Rename one of the two files.

### QUEUE_PLUGIN_INCOMPATIBLE

The `hubQueue()` plugin in the Vite config does not expose the Queue Nitro config. This occurs when the app has two versions of `@vite-hub/queue`. Install one version.

### QUEUE_PROVISION_FAILED

`vitehub provision run` received a queue list from Cloudflare that it cannot use. Run it again with `--dry-run`, and check the permissions of the Cloudflare token.

## Local delivery

The local provider is the Queue Provider of the Node preset. It runs in the server process, so it works with `node .output/server/index.mjs`, in Docker, in `vite dev`, and in a StackBlitz WebContainer. In `vite dev`, a Cloudflare or Vercel app uses it too, with the rules of [Dev delivery](#dev-delivery).

- `runQueue()` writes the job to a file in `.vitehub/data/queue` and returns. The server process then runs the Queue Definition.
- A failed job runs again after 1, 2, and 4 seconds. After 4 attempts, or after a Queue error that a retry cannot fix, the job becomes a dead job. A dead job stays in its file with the last error, and `vitehub queue list` counts it. The provider keeps the 100 newest dead jobs of each Queue Definition and deletes older ones. `vitehub queue list` shows this limit as `deadLimit`. `vitehub queue jobs retry <message-id>` runs a dead job again, and `vitehub queue jobs clear --state dead` removes the dead jobs.
- The attempt count is written before the handler runs. When the process stops during a handler, the job runs again after the restart with the next attempt number. When the process stopped during the fourth attempt, the job becomes a dead job and does not run again, so a handler that crashes the process cannot run on every restart.
- Delivery is at least once. A successful handler can run again after a restart if the process stops before completion is saved, or if both deleting the job and saving its completed state fail. Make handler side effects idempotent.
- `delaySeconds` survives a restart. `idempotencyKey` returns the message ID of a pending or running job with the same key, also for two sends at the same time. A dead job does not hold its key, so a new send with that key runs.
- `sendBatch()` stores all jobs or none. When one file cannot be written, it returns `QUEUE_PROVIDER_FAILED` and removes the other files of the batch, so a retry does not store the jobs two times.
- `concurrency` limits the jobs of one Queue Definition that run at the same time. The default is 1. `onError` and `callbackOptions` are Cloudflare and Vercel options, and the local provider does not call them.
- The jobs survive a restart on the same host and the same disk. They are lost with an ephemeral container filesystem, and another host does not see them. Mount `.vitehub/data` as a volume in Docker. Run one server process per directory. The provider has no lock between processes, so two processes on one directory can run the same job at the same time. Use Cloudflare or Vercel for more than one server.

## Dev delivery

In `vite dev` and `nuxt dev`, every app runs its Queue jobs in the dev server with the local provider, whatever the provider of the build. The dev server stores the jobs in `.vitehub/data/queue` of the project and follows the documented defaults of the provider of the build. The build output does not change.

| Rule | Cloudflare | Vercel | Local |
| --- | --- | --- | --- |
| Attempts | 4 (`max_retries` 3) | No limit until the job expires | 4 |
| Retry delay | None | 60 seconds (`retryAfterSeconds`) | 1, 2, then 4 seconds |
| Largest `delaySeconds` | 86400 (24 hours) | 604800 (7 days) | No limit |
| Retention | None | `retentionSeconds` from 60 to 604800, default 86400 | None |
| Largest payload | 128 KB of JSON | 100 MB of JSON | No limit |
| Largest `sendBatch()` | 100 jobs, 256 KB | 100 jobs | No limit |
| Rejected options | `idempotencyKey`, `region`, `retentionSeconds` | `contentType` | `contentType`, `region`, `retentionSeconds` |

The rules come from the [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Cloudflare batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), the [Vercel Queues concepts](https://vercel.com/docs/queues/concepts), and the [Vercel Queues limits](https://vercel.com/docs/queues/pricing#limits). A broken limit fails the send with [`QUEUE_PROVIDER_FAILED`](#queue_provider_failed), and `error.cause` names the limit. A rejected option fails with [`QUEUE_UNSUPPORTED_OPTION`](#queue_unsupported_option) and names the provider of the build, as on the host.

Dev does not emulate these parts of the host:

- It runs one job at a time per Queue Definition, up to `concurrency`. It has no Cloudflare batches, `max_batch_size`, or `max_batch_timeout`.
- It does not call `onError` or `callbackOptions`. A failed handler retries by the rules above, and a [Queue error that a retry cannot fix](#errors-in-a-queue-handler) makes the job dead at once.
- It keeps a dead job, so you can inspect it and run it again. Cloudflare deletes it or moves it to a dead-letter queue. Vercel deletes a job when it expires.
- The handler gets a JSON copy of the payload. Cloudflare `contentType: 'v8'` can send values that JSON cannot, such as a `Map`. Dev measures the payload as JSON, not in the provider encoding.
- `idempotencyKey` deduplicates only while a job is pending or running. Vercel deduplicates for the retention, up to 24 hours.
- `getQueue()` returns the local client, so `client.provider` is `'local'`.

`vitehub queue jobs list|show|retry|clear` and the Console read the stored jobs through the `queue.jobs-*` operations. A handler that throws a plain `Error` reports `Queue Delivery failed.`, because a message can hold private data. Throw a `ViteHubError` to keep a code and a message. On Cloudflare and Vercel, the job commands fail with `QUEUE_JOBS_UNAVAILABLE`, because those providers do not let the app read the queue. A missing message ID fails with `QUEUE_JOB_NOT_FOUND`, and a job that runs now fails `retry` with `QUEUE_JOB_RUNNING`.

## Production checks

- A successful `runQueue()` means that the provider accepted the job. Track handler results in your own storage, or use [Workflows](/docs/workflows) when the caller needs run status.
- Providers can deliver a job more than once. Make handlers safe to run again after a partial side effect.
- Cloudflare needs a deployed request-scoped binding and an existing queue. `vitehub provision run --provider cloudflare` can create the generated queues when account credentials are present. See [Provisioning](/docs/development/provisioning).
- The local provider keeps jobs on one host. See [Local delivery](#local-delivery).
- Vercel needs the generated topic, the `@vercel/queue` runtime, and a resolvable region when the installed SDK requires one.
