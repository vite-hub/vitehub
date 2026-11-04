---
title: Queue concepts
description: Understand what queue acceptance, delivery, retries, and provider output mean for a Queue Definition.
navigation.title: Concepts
navigation.order: 8
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Queue separates accepting work from running the handler. `runQueue()` sends
a typed payload to the configured provider and returns when the provider accepts
the message. The handler runs later, often in another process or region.

## Acceptance is not completion

The result from `runQueue()` tells you whether the provider accepted the job.
It does not contain the handler result. Give the job an id or an application
key when you need to show progress, then store the final state in a durable
primitive such as [KV](/docs/kv) or [Database](/docs/database).

## Delivery can happen again

Providers retry failed delivery. Write handlers so a second delivery is safe.
Use an idempotency key before sending an email, charging a card, or changing a
record. See [Queue limits and errors](/docs/queue/limits-and-errors) for
provider limits and failure codes.

On the `node` preset, the local provider stores jobs in `.vitehub/data/queue`
and runs them in the server process. The jobs survive a restart on the same
disk, but one host owns them. On Cloudflare and Vercel, the Vite integration
generates provider output and the provider delivers the jobs. See
[Queue hosts](/docs/queue/hosts).
