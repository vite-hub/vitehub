---
title: When to use Queue
description: Decide when Queue is the right primitive compared with inline request handling.
navigation.title: When to use Queue
frameworks: [vite, nitro]
---

Use Queue when work should continue after the current request returns and the job can be processed independently.

## Choose Queue when

Queue is a good fit when:

- the request should return before the work finishes
- you want retries or delayed delivery from the provider
- one handler can process one unit of background work
- the enqueue call should stay portable while the provider changes

Common examples:

- sending a welcome email
- delivering a webhook to a slower downstream system
- buffering event processing outside the request path
- handing off work to Cloudflare or Vercel queue infrastructure

## Prefer inline request work when

Queue is usually the wrong fit when:

- the caller needs the result before you respond
- the work is small enough that inline execution is simpler
- there is no need for delayed delivery or provider-managed retries

## Queue vs time-based scheduling

Queue is event-driven. It starts when your app decides to enqueue work.

Use a scheduler or cron primitive when the clock should decide when work starts.

## Next steps

- Start with [Quickstart](./quickstart) for one working queue.
- Use [Usage](./usage) for enqueue patterns and provider handles.
- Use [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for provider-specific setup.
