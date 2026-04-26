---
title: Queue troubleshooting
description: Diagnose unknown queue definitions, disabled queues, missing Cloudflare bindings, Vercel region failures, and unsupported enqueue options.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite, nitro]
---

Use this page by symptom. Each section gives the likely cause, the fix, and a quick verification step.

## `Unknown queue definition: welcome-email`

**Cause:** The queue file is outside the discovery path, the route uses the wrong name, or the generated runtime registry has not been refreshed.

::fw{id="vite:dev vite:build"}
Vite discovers `src/**/*.queue.ts`. `src/welcome-email.queue.ts` becomes `welcome-email`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers `server/queues/**`. `server/queues/welcome-email.ts` becomes `welcome-email`.
::

**Fix:** Move the definition into the discovery path or update the `runQueue()` name.

**Verify:** Restart dev mode or rebuild, then call the route again.

## `Queue is disabled`

**Cause:** Queue runtime config resolved to `false`.

**Fix:** Remove `queue: false` or configure a provider:

```ts
queue: {
  provider: 'cloudflare',
}
```

**Verify:** Call `runQueue()` again. A provider-specific error means Queue is enabled and setup has moved to the next issue.

## Cloudflare binding resolution fails

**Cause:** The Cloudflare provider is configured, but the current runtime cannot resolve the queue binding.

Common messages include:

```txt
Cloudflare queue direct clients require a binding.
Cloudflare queue binding names require request-scoped runtime resolution.
Invalid Cloudflare queue binding. Expected an object with send() and sendBatch().
```

**Fix:** Run inside a Cloudflare request context with the generated binding, or set `queue.binding` to the binding name you already provide.

```ts
queue: {
  provider: 'cloudflare',
  binding: 'WELCOME_EMAIL_QUEUE',
}
```

**Verify:** Inspect the generated Wrangler queue producers or call `getCloudflareQueueBindingName('welcome-email')` to compare names.

## Vercel SDK cannot load

**Cause:** The Vercel provider is configured, but `@vercel/queue` is not installed.

**Fix:** Install the provider SDK:

```bash
pnpm add @vercel/queue
```

**Verify:** Restart the app or rebuild so the dependency can be imported.

## `VERCEL_QUEUE_REGION_REQUIRED`

**Cause:** The active `@vercel/queue` client needs a region, and Queue could not resolve one.

**Fix:** Set one of these:

```ts
queue: {
  provider: 'vercel',
  region: 'fra1',
}
```

```bash
QUEUE_REGION=fra1
VERCEL_REGION=fra1
```

**Verify:** Restart the app or redeploy so runtime env vars are available.

## Unsupported enqueue options

**Cause:** The send envelope includes options the active provider does not support.

| Provider | Unsupported fields |
| --- | --- |
| Cloudflare | `idempotencyKey`, `retentionSeconds` |
| Vercel | `contentType` |

**Fix:** Keep provider-specific fields close to provider-specific routes or helpers.

```ts
await runQueue('welcome-email', {
  payload: { email: 'ava@example.com' },
  delaySeconds: 30,
})
```

**Verify:** Call the route again. The enqueue response should return `{ "status": "queued" }`.

## Vercel output fails because queue names collide

**Cause:** Two queue names sanitize to the same Vercel function path. For example, names that differ only by unsupported punctuation can collide after output sanitization.

**Fix:** Rename one queue file so the discovered names are distinct after sanitization.

**Verify:** Re-run the build. The collision error should be gone.

## Deferred dispatch failed

**Cause:** `deferQueue()` schedules enqueue work after the response path. The provider send failed asynchronously.

**Fix:** Add `onDispatchError` to the definition while debugging:

```ts
export default defineQueue(handler, {
  onDispatchError(error, context) {
    console.error(context.name, error)
  },
})
```

**Verify:** Check runtime logs after calling the route that uses `deferQueue()`.
