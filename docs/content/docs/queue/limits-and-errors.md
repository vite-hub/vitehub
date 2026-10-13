---
title: Queue limits and errors
description: Handle Queue error codes and check delivery guarantees before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Errors

Queue APIs throw the shared `ViteHubError`. Built-in failures use the closed `QueueErrorCode` union, fixed public messages, and allowlisted details such as `{ provider, operation }`. The raw SDK or binding failure stays in `error.cause` for protected server-side diagnostics. `JSON.stringify(error)` uses the shared safe shape and omits `cause`.

Application failures can use any stable code with a public message, JSON-safe `details`, an optional `requestId`, and a non-serialized `cause`:

```ts
new ViteHubError('WELCOME_EMAIL_REJECTED', 'Welcome email was rejected.', {
  cause,
  details: { campaign: 'welcome' },
})
```

When you migrate from package-specific Queue errors, import `ViteHubError` from `@vite-hub/runtime` for application failures. Move acknowledgement and retry decisions into `onError` or `callbackOptions.retry`.

| Code | Meaning |
| --- | --- |
| `QUEUE_DISABLED` | Queue runtime support is disabled. |
| `QUEUE_DEFINITION_NOT_FOUND` | No discovered Queue Definition matches the requested name. |
| `QUEUE_DEFINITION_LOAD_FAILED` | A discovered Queue Definition could not be loaded. |
| `QUEUE_PROVIDER_OPERATION_FAILED` | Queue client creation, send, or batch send failed. |
| `QUEUE_PROVIDER_RESPONSE_INVALID` | A successful Vercel send returned a missing or malformed `messageId`. |
| `CLOUDFLARE_BINDING_RESOLUTION_REQUIRED` | A direct Cloudflare client was created without a concrete binding. |
| `CLOUDFLARE_BINDING_INVALID` | The Cloudflare binding does not expose `send()` and `sendBatch()`. |
| `CLOUDFLARE_UNSUPPORTED_ENQUEUE_OPTIONS` | Cloudflare received unsupported enqueue options: `idempotencyKey`, `region`, or `retentionSeconds`. |
| `VERCEL_QUEUE_SDK_LOAD_FAILED` | `@vercel/queue` could not be loaded. |
| `VERCEL_QUEUE_SDK_INVALID` | `@vercel/queue` did not expose the expected client API. |
| `VERCEL_QUEUE_REGION_REQUIRED` | Vercel region could not be resolved for the installed SDK shape. |
| `VERCEL_PROVIDER_EXPECTED` | Hosted Vercel Queue Delivery resolved another provider. |
| `VERCEL_TOPIC_RESOLUTION_REQUIRED` | A direct Vercel client was created without a topic. |
| `VERCEL_UNSUPPORTED_ENQUEUE_OPTIONS` | Vercel received unsupported enqueue options such as `contentType`. |

## Production checks

- `runQueue()` resolves when the provider accepts the job. Track handler results in your own storage, or use [Workflows](/docs/workflows) when the caller needs run status.
- Providers can deliver a job more than once. Make handlers safe to run again after a partial side effect.
- Cloudflare needs a deployed request-scoped binding and an existing queue. `vitehub provision run --provider cloudflare` can create the generated queues when account credentials are present. See [Provisioning](/docs/development/provisioning).
- Vercel needs the generated topic, the `@vercel/queue` runtime, and a resolvable region when the installed SDK requires one.
