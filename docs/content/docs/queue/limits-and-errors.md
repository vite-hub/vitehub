---
title: Queue limits and errors
description: Handle Queue errors by code, repair Queue configuration errors, and check delivery guarantees before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle Queue errors

`sendQueue()`, `dynamicQueue.send()`, `send()`, and `sendBatch()` return `[error, result]`. An `error` has:

- `code`: the failure name
- `why`: what went wrong
- `fix`: what to do
- `docs`: a link to the code in [Queue diagnostics](/docs/queue/diagnostics)
- `cause`: the provider error

```ts [server/queues/welcome-email.ts]
import { defineQueue } from 'vite-hub/queue'

export default defineQueue<{ email: string }>(async ({ payload }) => {
  console.log(`Welcome ${payload.email}`)
})
```

```ts [server/api/signup.post.ts]
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { sendQueue } from 'vite-hub/queue'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, v.parser(v.object({ email: v.string() })))
  const [error, result] = await sendQueue('welcome-email', { email: body.email })
  if (error) {
    console.error(error.code, error.why, error.cause)
    throw error
  }
  return result
})
```

`error.code` is typed as the codes that the method can return. `sendQueue()` can return `QUEUE_PROVIDER_FAILED`, `QUEUE_PROVIDER_INVALID_RESPONSE`, or `QUEUE_UNSUPPORTED_OPTION`. A Cloudflare `send()` never returns `QUEUE_PROVIDER_INVALID_RESPONSE`.

`JSON.stringify(error)` keeps only `name`, `code`, `why`, `fix`, and `docs`. It drops `cause` and `stack`, because provider errors can hold credentials or private data. Log `cause` only on the server.

Config errors throw instead, such as an unknown queue name or a missing Cloudflare binding. The code or the deployment must change, so a retry cannot help. `useQueue()` and `createQueueClient()` also throw them, because they only prepare a client. `deferQueue()` returns nothing: it logs a failure and passes it to `onDispatchError`.

| Code | Returned by | Thrown |
| --- | --- | --- |
| `QUEUE_PROVIDER_FAILED` | Every send method | `useQueue()`, when the client cannot start |
| `QUEUE_PROVIDER_INVALID_RESPONSE` | Vercel `send()`, `sendQueue()` | |
| `QUEUE_UNSUPPORTED_OPTION` | Every send method | |
| `QUEUE_BINDING_NOT_FOUND`, `QUEUE_DEFINITION_LOAD_FAILED`, `QUEUE_DEFINITION_NOT_FOUND`, `QUEUE_DISABLED`, `QUEUE_INVALID_BINDING`, `QUEUE_LOCAL_MODE_MISMATCH`, `QUEUE_MISSING_QUEUE`, `QUEUE_MISSING_REGION`, `QUEUE_MISSING_TOPIC`, `QUEUE_PROVIDER_MISMATCH`, `QUEUE_RUNTIME_NOT_INSTALLED`, `QUEUE_VERCEL_SDK_INVALID`, `QUEUE_VERCEL_SDK_UNAVAILABLE` | | When an operation starts |
| `QUEUE_BINDING_CONFLICT`, `QUEUE_CRYPTO_UNAVAILABLE`, `QUEUE_DEFINITIONS_CHANGED`, `QUEUE_INVALID_CONFIG`, `QUEUE_INVALID_DEFINITION`, `QUEUE_INVALID_NAME`, `QUEUE_INVALID_PROVIDER`, `QUEUE_MISSING_PROVIDER`, `QUEUE_NAME_COLLISION`, `QUEUE_PLUGIN_INCOMPATIBLE`, `QUEUE_PROVISION_FAILED` | | At define time, at Vite config, or at build |

### Errors in a Queue handler

When a handler throws, ViteHub logs the error and the provider retries, except for Queue errors that a retry cannot fix. Cloudflare acknowledges those. Vercel acknowledges them when `callbackOptions.retry` returns `undefined`. The local provider keeps them as dead jobs. `QUEUE_PROVIDER_FAILED` and `QUEUE_PROVIDER_INVALID_RESPONSE` retry; every other Queue code is acknowledged. On Cloudflare or Vercel, `onError` or `callbackOptions.retry` can pick another action. The local provider does not call them. See [Local delivery](#local-delivery).

Throw `ViteHubError` from `vite-hub/runtime` to give a failure a stable code. The code does not change the retry policy.

```ts fragment
new ViteHubError('WELCOME_EMAIL_REJECTED', 'Welcome email was rejected.', {
  cause,
  details: { campaign: 'welcome' },
})
```

## Runtime errors

### QUEUE_PROVIDER_FAILED

The provider rejected a send, a batch send, or a client start. `error.why` names the provider and operation, and `error.cause` holds the provider error. A retry can help once the provider is back. On Vercel, pass `idempotencyKey` so a retry does not send the job twice.

### QUEUE_PROVIDER_INVALID_RESPONSE

A Vercel response with `messageId: null` means the job is accepted for later processing, and `result.messageId` is `undefined`. A missing or invalid `messageId` is this error. The job may be in the queue, so do not send it again without an `idempotencyKey`. Check your `@vercel/queue` version.

### QUEUE_UNSUPPORTED_OPTION

The provider does not support an option. Cloudflare rejects `idempotencyKey`, `region`, and `retentionSeconds`. Vercel rejects `contentType`. The local provider rejects `contentType`, `region`, and `retentionSeconds`. See [Queue Enqueue options](/docs/queue/server-api#queue-enqueue-options).

## Configuration errors

### QUEUE_BINDING_NOT_FOUND

The Cloudflare client has no binding, or the request env lacks the generated binding. `error.why` names the binding when it is a valid identifier. Run the Worker that `vite build` writes, with `wrangler dev` or a deployment, so its config has the binding. A custom Worker config must keep it. Dev servers use the local provider and need no binding, but a direct Cloudflare client from `createQueueClient()` still needs one.

### QUEUE_DEFINITION_LOAD_FAILED

A queue file threw when it loaded. `error.cause` holds the import error.

### QUEUE_DEFINITION_NOT_FOUND

No queue has this name, or a Cloudflare queue maps to no Queue Definition. `error.why` names the queue only when the name is a safe identifier. The generated server output loads the queues, so a script outside it, or an app built without Queue, finds none. In Vitest, with `hubQueue(false)`, `sendQueue()` reports [`QUEUE_DISABLED`](#queue_disabled) instead.

### QUEUE_DISABLED

The Queue config that this runtime installed is `false`. The generated Vitest setup installs `false` when `hubQueue()` gets `false`, or when `queue.provider` does not match the host. A dev or built server registers no Queue runtime in these cases, so Queue calls throw [`QUEUE_DEFINITION_NOT_FOUND`](#queue_definition_not_found) there.

### QUEUE_INVALID_BINDING

The Cloudflare binding lacks `send()` and `sendBatch()`. Pass a Queue producer binding.

### QUEUE_LOCAL_MODE_MISMATCH

A process has one local engine per folder. Clients that ask for different dev error display modes cannot share it. Direct clients from `createQueueClient()` always hide plain handler errors. Use `useQueue()` to share the dev runtime, or give the direct client its own `base` folder.

### QUEUE_MISSING_QUEUE

A direct local client from `createQueueClient({ provider: 'local' })` needs `queue`, the name of the queue that runs the jobs. `useQueue()` sets it for you.

### QUEUE_MISSING_REGION

Your `@vercel/queue` needs a region. ViteHub reads `queue.region`, then `QUEUE_REGION`, then `VERCEL_REGION`, then the current Vercel request. Set one.

### QUEUE_MISSING_TOPIC

A direct Vercel client from `createQueueClient()` needs a `topic`. `useQueue()` sets it for you.

### QUEUE_PROVIDER_MISMATCH

The generated runtime got another provider. Set `queue.provider` to match the deployment host, and build again.

### QUEUE_RUNTIME_NOT_INSTALLED

The Queue runtime has no client factory, which the generated server output installs. Set `queue` in `vitehub()`, or add `hubQueue()` to the Vite plugins when you use `@vite-hub/queue` alone. Then build and run the built server.

### QUEUE_VERCEL_SDK_INVALID

`@vercel/queue`, or the `client` you passed, lacks `send()` and `handleCallback()`. Install a supported `@vercel/queue` version.

### QUEUE_VERCEL_SDK_UNAVAILABLE

`@vercel/queue` or `@vercel/functions` cannot be loaded. Queue lists both as optional peers, so a Vercel app installs them. Add them to the app dependencies. Read `error.cause` for the import error.

## Definition and build errors

### QUEUE_BINDING_CONFLICT

A custom `queue.binding` works with one queue only. Remove it, so each queue gets its own binding.

### QUEUE_CRYPTO_UNAVAILABLE

A long queue name gets a hashed Cloudflare name, and the hash needs `node:crypto`. Turn on the `nodejs_compat` flag, or use a shorter name.

### QUEUE_DEFINITIONS_CHANGED

Queue files changed after Vite resolved the config. Generate them before that.

### QUEUE_INVALID_CONFIG

`queue` is not a plain object or `false`.

### QUEUE_INVALID_DEFINITION

`defineQueue()` received no handler function.

### QUEUE_INVALID_NAME

The generated Cloudflare queue name has characters that Cloudflare rejects. Use only letters, numbers, and dashes in `queue.namePrefix`.

### QUEUE_INVALID_PROVIDER

`queue.provider` is not `cloudflare`, `vercel`, or `local`.

### QUEUE_MISSING_PROVIDER

ViteHub cannot pick a provider for the host, such as Netlify or Deno. Set `queue.provider`, use the Cloudflare, Vercel, or Node host, or set `queue: false`.

### QUEUE_NAME_COLLISION

Two queues get the same Cloudflare queue name or Vercel route. Rename one file.

### QUEUE_PLUGIN_INCOMPATIBLE

The `hubQueue()` plugin does not expose the Queue Nitro config, because the app has two versions of `@vite-hub/queue`. Install one.

### QUEUE_PROVISION_FAILED

`vitehub provision run` got a queue list from Cloudflare that it cannot use. Run it with `--dry-run`, and check the Cloudflare token's permissions.

## Local delivery

The local provider is the Node host's provider. It runs in the server process, so it works with `node .output/server/index.mjs`, in Docker, in `vite dev`, and in a StackBlitz WebContainer. Cloudflare and Vercel apps also use it in `vite dev`, with the [Dev delivery](#dev-delivery) rules.

- `sendQueue()` writes the job to a file in `.vitehub/data/queue` and returns. The server then runs the queue.
- A failed job runs again after 1, 2, and 4 seconds. After 4 attempts, or a Queue error that a retry cannot fix, it becomes a dead job. A dead job stays in its file with the last error. The provider keeps the 100 newest dead jobs per queue and deletes older ones. `vitehub queue list` counts them and shows the limit as `deadLimit`. `vitehub queue jobs retry <message-id>` runs a dead job again, and `vitehub queue jobs clear --state dead` removes them.
- The attempt count is saved before the handler runs. If the process stops during a handler, the job runs again after restart with the next attempt number. If it stopped during the fourth attempt, the job becomes dead, so a handler that crashes the process cannot run on every restart.
- Delivery is at least once. A successful handler can run again after a restart if the process stops before it saves completion, or if deleting the job and saving its state both fail. Make side effects safe to repeat.
- `delaySeconds` survives a restart. `idempotencyKey` returns the message ID of a pending or running job with the same key, also for two sends at once. A dead job frees its key, so a new send with it runs.
- `sendBatch()` stores all jobs or none. If one file fails, it returns `QUEUE_PROVIDER_FAILED` and removes the batch's other files, so a retry does not store jobs twice.
- `concurrency` limits how many jobs of one queue run at once. The default is 1. The local provider does not call `onError` or `callbackOptions`.
- Jobs survive a restart on the same host and disk. A temporary container filesystem loses them, and other hosts cannot see them. In Docker, mount `.vitehub/data` as a volume.

> [!WARNING]
> Run one server process per folder. The provider has no lock between processes, so two processes on one folder can run the same job at once. For more than one server, use Cloudflare or Vercel.

## Dev delivery

In `vite dev` and `nuxt dev`, every app runs its jobs in the dev server with the local provider, for any build provider. Jobs go to the project's `.vitehub/data/queue`, with the documented defaults of the build's provider. The build output does not change.

| Rule | Cloudflare | Vercel | Local |
| --- | --- | --- | --- |
| Attempts | 4 (`max_retries` 3) | No limit until the job expires | 4 |
| Retry delay | None | 60 seconds (`retryAfterSeconds`) | 1, 2, then 4 seconds |
| Largest `delaySeconds` | 86400 (24 hours) | 604800 (7 days) | No limit |
| Retention | None | `retentionSeconds` from 60 to 604800, default 86400 | None |
| Largest payload | 128 KB of JSON | 100 MB of JSON | No limit |
| Largest `sendBatch()` | 100 jobs, 256 KB | 100 jobs | No limit |
| Rejected options | `idempotencyKey`, `region`, `retentionSeconds` | `contentType` | `contentType`, `region`, `retentionSeconds` |

The rules come from the [Cloudflare Queues limits](https://developers.cloudflare.com/queues/platform/limits/), [Cloudflare batching and retries](https://developers.cloudflare.com/queues/configuration/batching-retries/), the [Vercel Queues concepts](https://vercel.com/docs/queues/concepts), and the [Vercel Queues limits](https://vercel.com/docs/queues/pricing#limits). A broken limit fails the send with [`QUEUE_PROVIDER_FAILED`](#queue_provider_failed), and `error.cause` names the limit. A rejected option fails with [`QUEUE_UNSUPPORTED_OPTION`](#queue_unsupported_option) and names the build's provider, as on the host.

Dev differs from the host:

- It runs jobs one by one, up to `concurrency` per queue. It has no Cloudflare batches, `max_batch_size`, or `max_batch_timeout`.
- It does not call `onError` or `callbackOptions`. A failed handler retries by the rules above. A [Queue error that a retry cannot fix](#errors-in-a-queue-handler) makes the job dead at once.
- It keeps dead jobs for you to inspect and rerun. Cloudflare deletes them or moves them to a dead-letter queue. Vercel deletes a job when it expires.
- The handler gets a JSON copy of the payload. Cloudflare `contentType: 'v8'` can send values that JSON cannot, such as a `Map`. Dev measures size as JSON, not in the provider encoding.
- `idempotencyKey` deduplicates only while a job is pending or running. Vercel does it for the retention time, up to 24 hours.
- `useQueue()` returns the local client, so `client.provider` is `'local'`.

`vitehub queue jobs list|show|retry|clear` and the Console read stored jobs through the `queue.jobs-*` operations. In `vite dev`, a plain `Error` from a handler reports its message and stack, and `jobs show` prints both. A production server reports `Queue Delivery failed.`, because a message can hold private data. Throw a `ViteHubError` to keep a code and message there. A production local server that reopens jobs stored by `vite dev` hides their stored errors that have no code. Queue errors and `ViteHubError` keep their code and message.

On Cloudflare and Vercel, the job commands fail with `QUEUE_JOBS_UNAVAILABLE`, because those providers do not let the app read the queue. An unknown message ID fails with `QUEUE_JOB_NOT_FOUND`. `retry` on a running job fails with `QUEUE_JOB_RUNNING`.

## Production checks

- A successful `sendQueue()` means the provider accepted the job. Track results in your own storage, or use [Workflows](/docs/workflows) when the caller needs run status.
- A job can arrive more than once. Make handlers safe to rerun after a partial side effect.
- Cloudflare needs a deployed binding and an existing queue. With account credentials, `vitehub provision run --provider cloudflare` can create the queues. See [Provisioning](/docs/development/provisioning).
- The local provider keeps jobs on one host. See [Local delivery](#local-delivery).
- Vercel needs the generated topic, the `@vercel/queue` runtime, and a region if your SDK version needs one.
