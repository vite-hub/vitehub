---
title: Choose Queue, Workflow, or Schedule for TypeScript background jobs
seo.title: "Queue, Workflow, or Schedule for background jobs"
description: Choose a ViteHub API for queued jobs, durable multi-step work, or cron triggers, with host and retry limits made explicit.
navigation.title: Background jobs
navigation.order: 23
navigation.group: Server work
icon: i-lucide-workflow
---

Pick the API from what starts the job and how long it runs. A background job
needs a provider that runs it after the request ends, which an untracked
promise cannot do.

## Match the API to the job

| Job | Use | Reason |
| --- | --- | --- |
| Process an upload after the route replies. | [Queue](/docs/queue) | Delivers a message to a consumer. |
| Create a record, call a service, resume after a failed step. | [Workflow](/docs/workflows) | Tracks runs and steps. |
| Start a daily report at a set time. | [Schedule](/docs/schedule) | A cron trigger starts it. |
| Return a short result in the request. | A server route or inline Agent. | The request owns the work. |

A Schedule can start a Workflow or send a Queue message. Keep the timer apart
from the job to test the job without waiting.

## Choose a provider that owns execution

- **Queue** uses Cloudflare Queues, Vercel Queues, or the local provider of a
  Node server. `pnpm dev` runs jobs in the dev server with the provider's retry
  rules. `vitehub queue jobs list` shows them. A sent message does not mean the
  consumer finished.
- **Workflow** supports Cloudflare, Vercel, and the documented OpenWorkflow
  stores for self-hosting. [Workflow hosts](/docs/workflows/hosts) lists what
  each needs.
- **Schedule** writes the host's cron config where the host supports it. A
  process-based scheduler needs one Node process that stays up, not a
  serverless function. For Netlify or Deno, read
  [Schedule hosts](/docs/schedule/hosts) before you pick the output mode.

## Design for retries and overlap

A delivery or a step can run twice. Use a stable job key and save the result
before you report success. Pass an idempotency key to external APIs that take
one. A retry must not charge a customer or send an email twice.

For a repeating job, decide what happens when the last run is still active.
A cron expression does not coordinate app instances.

## Verify more than the start call

Check one finished job and one failed job, then the retry or restart behavior
your app needs. Check the provider's final state and the external result, not
only the returned ID.

Start with [Queue](/docs/queue/get-started),
[Workflow](/docs/workflows/get-started), or
[Schedule](/docs/schedule/get-started). The
[support matrix](/docs/frameworks-hosts/support-matrix) shows which checks ran
on a live provider.
