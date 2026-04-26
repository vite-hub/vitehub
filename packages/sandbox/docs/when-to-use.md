---
title: When to use Sandbox
description: Decide when Sandbox is the right execution primitive compared with inline request work, Queue, cron, or plain server code.
navigation.title: When to use Sandbox
navigation.order: 2
icon: i-lucide-git-compare
frameworks: [vite, nitro]
---

Use Sandbox when a request needs to run code in an isolated provider runtime and return a result to the caller.

Sandbox is not a background queue. It is still a direct execution path: your route calls `runSandbox()`, waits for a result, and decides what to return.

## Choose Sandbox when

Sandbox is a good fit when:

- the work should run outside the main request handler runtime
- the caller needs the result before the response finishes
- a named definition gives you a useful boundary for typed payloads and return values
- provider setup should stay behind one portable `runSandbox()` call
- the work may need a stable sandbox identity for reuse

Common examples:

- transforming generated release notes
- running code that needs stronger runtime isolation
- evaluating user-provided or agent-produced code behind your own validation layer
- executing a provider-specific sandbox workflow without spreading provider code through routes

## Prefer inline request work when

Inline code is usually better when:

- the work is trusted application logic
- the work is small and does not need isolation
- the route can run the code directly with less operational overhead
- the provider sandbox would make the request slower without changing the safety model

```ts [server/api/health.get.ts]
export default defineEventHandler(() => {
  return { ok: true }
})
```

## Prefer Queue when

Use [Queue](../queue) when the request should return before the work finishes.

| Need | Primitive |
| --- | --- |
| Return a computed result from isolated execution | Sandbox |
| Fire-and-forget a background job | Queue |
| Retry delayed work through provider infrastructure | Queue |
| Keep request code isolated but synchronous from the caller's point of view | Sandbox |

## Prefer cron or scheduling when

Use a scheduler when time starts the work.

Sandbox starts when your app calls `runSandbox()`. A cron job starts when the clock says so. You can combine them by having a scheduled handler call `runSandbox()`, but the trigger is still the scheduler.

## Decision checklist

Choose Sandbox when all of these are true:

- The route needs a result from the work.
- The work benefits from isolation.
- The work can be expressed as one named definition.
- Provider-specific setup should stay out of the route.

If any of those are false, start with inline request work or Queue.

## Next steps

- Start with [Quickstart](./quickstart) for a complete first sandbox.
- Use [Run a sandbox](./guides/run-a-sandbox) for the route-side pattern.
- Use [Reuse a sandbox](./guides/reuse-a-sandbox) when stable sandbox identity matters.
