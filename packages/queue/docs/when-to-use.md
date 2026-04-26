---
title: When to use Queue
description: Decide when Queue is the right background primitive compared with inline request work, Sandbox, cron, or plain provider code.
navigation.title: When to use Queue
navigation.order: 2
icon: i-lucide-git-compare
frameworks: [vite, nitro]
---

Use Queue when a request should hand off work, return to the caller, and let provider queue infrastructure process the job later.

Queue is not a direct execution primitive. `runQueue()` confirms that the message was queued; it does not return the handler result.

## Choose Queue when

Queue is a good fit when:

- the request should return before the work finishes
- retries or delayed delivery should be handled by the provider
- one named handler can process one background job
- the producer call should stay portable while provider setup changes
- the work can be repeated safely if the provider retries delivery

Common examples:

- sending a welcome email
- delivering a webhook to a slower downstream system
- buffering analytics or event processing outside the request path
- handing off work to Cloudflare or Vercel queue infrastructure

## Prefer inline request work when

Inline code is usually better when:

- the caller needs the result before the response finishes
- the work is trusted application logic and completes quickly
- retry and delayed delivery are not needed
- adding queue infrastructure would make the behavior harder to reason about

```ts [server/api/profile.get.ts]
export default defineEventHandler(async (event) => {
  const user = await getUser(event)
  return { user }
})
```

## Prefer Sandbox when

Use [Sandbox](../sandbox) when the caller needs a result from code that should run in an isolated provider runtime.

| Need | Primitive |
| --- | --- |
| Return a computed result from isolated execution | Sandbox |
| Fire-and-forget background work | Queue |
| Retry delayed work through provider infrastructure | Queue |
| Keep request code direct and synchronous | Inline request work |

## Prefer cron or scheduling when

Use a scheduler when time starts the work.

Queue starts when your app calls `runQueue()` or `deferQueue()`. A cron job starts when the clock says so. You can combine them by having a scheduled handler enqueue jobs, but the trigger is still the scheduler.

## Decision checklist

Choose Queue when all of these are true:

- The route does not need the handler result.
- The work can run after the response.
- A provider retry will not corrupt the job.
- The work can be expressed as one named queue definition.
- Provider-specific delivery should stay out of the route.

If any of those are false, start with inline request work or Sandbox.

## Next steps

- Start with [Quickstart](./quickstart) for a complete first queue.
- Use [Enqueue a job](./guides/enqueue-a-job) for producer-side patterns.
- Use [Handle provider delivery](./guides/handle-provider-delivery) for Cloudflare batch and Vercel callback behavior.
