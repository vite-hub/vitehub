---
title: Queue concepts
description: Understand what queue acceptance, delivery, retries, and provider output mean for a Queue Definition.
navigation.title: Concepts
navigation.order: 3
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

The local Vite integration discovers Definitions and generates provider output,
but it does not emulate delivery. Use [Queue hosts](/docs/queue/hosts) and a
build inspection when you need to verify deployment wiring.
