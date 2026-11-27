---
title: Queue concepts
description: Understand what queue acceptance, delivery, retries, and provider output mean for a Queue Definition.
navigation.title: Concepts
navigation.order: 8
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Queue splits two steps: accepting work and running it. `sendQueue()` sends a
typed payload to the provider and returns when the provider accepts it. The
handler runs later, often in another process or region.

## Acceptance is not completion

`sendQueue()` tells you only that the provider accepted the job, not what the
handler returned. To show progress, put your own key in the payload, and
store the final state in [KV](/docs/kv) or a [Database](/docs/database).

## Delivery can happen again

Providers retry failed delivery, so a second delivery must be safe. Use an
idempotency key before you send an email, charge a card, or change a record.
See [limits and errors](/docs/queue/limits-and-errors).

On the `node` host, the local provider stores jobs in `.vitehub/data/queue`
and runs them in the server process. Jobs survive a restart on the same disk,
but stay on one host. On Cloudflare and Vercel, the Vite plugin generates
provider output, and the provider delivers the jobs. In `vite dev`, jobs run
in the dev server with the rules of the provider. See
[Queue hosts](/docs/queue/hosts).
