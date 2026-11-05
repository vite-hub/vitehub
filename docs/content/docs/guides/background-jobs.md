---
title: Choose Queue, Workflow, or Schedule for TypeScript background jobs
description: Choose a ViteHub API for queued jobs, durable multi-step work, or cron triggers, with host and retry limits made explicit.
navigation.title: Background jobs
navigation.order: 23
navigation.group: Server work
icon: i-lucide-workflow
---

Choose the API from the job's lifetime and trigger. A background job needs a
provider that can run it after the HTTP request ends. Starting an untracked
promise inside a route does not supply that guarantee.

## Match the API to the job

| Job | Use | Reason |
| --- | --- | --- |
| Process an uploaded file after the route replies. | [Queue](/docs/queue) | A provider delivers a message to a consumer. |
| Create a record, call another service, then resume after a failed step. | [Workflow](/docs/workflows) | The selected provider tracks runs and steps. |
| Start a daily report at a set time. | [Schedule](/docs/schedule) | A cron trigger starts the work. |
| Return a short result before the request ends. | A server route or inline Agent. | The request already owns the work's lifetime. |

A Schedule can start a Workflow or enqueue a message. Keep the time trigger
separate from the job so you can invoke and test the job without waiting.

## Choose a provider that owns execution

ViteHub Queue uses Cloudflare Queues or Vercel Queues. It has no local queue
worker provider. Use a provider-backed test before assuming that enqueue
means the consumer completed.

Workflow supports Cloudflare, Vercel, and the documented OpenWorkflow stores
for self-hosted use. Check [Workflow hosts](/docs/workflows/hosts) for storage,
durability, and execution requirements.

Schedule writes host cron output where supported. A process-based scheduler
needs one long-lived Node process. It cannot keep time after a serverless
function stops. Read [Schedule hosts](/docs/schedule/hosts) before selecting
the output mode for Netlify or Deno.

## Design for retries and overlap

Assume that a delivery or step can repeat. Use a stable job key and record the
result before reporting success. Check whether the external API supports an
idempotency key. A retry must not charge a customer or send an email twice.

For recurring jobs, define what happens when the previous run is still active.
A cron expression alone does not coordinate all application instances.

## Verify more than the start call

Check one completed job and one failed job. Then test the retry or restart
behavior that the application needs. Inspect the provider's terminal state
and the external result, not only the ID returned by the start call.

Start with [Queue](/docs/queue/get-started),
[Workflow](/docs/workflows/get-started), or
[Schedule](/docs/schedule/get-started). Use the
[support matrix](/docs/frameworks-hosts/support-matrix) to distinguish generated
output checks from live provider proof.
