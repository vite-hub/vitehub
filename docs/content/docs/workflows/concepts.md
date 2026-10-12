---
title: Workflow concepts
description: Understand workflow runs, durable steps, retries, and provider state before you design a long-running job.
navigation.title: Concepts
navigation.order: 3
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Workflow turns one request into a provider-tracked run. The start call
returns a run id, and later calls read the status or result by that id. Store
the id with the business record that needs to show progress.

## A run is the durable unit

The Definition describes the work. The run carries its payload, status, error,
and result. A provider can resume a run after a worker or process stops, so a
handler must keep side effects inside explicit durable steps when the provider
requires them.

Use a stable id when the same business operation must not start twice. Treat a
retry as possible and make external calls idempotent.

## Providers own the runtime state

Cloudflare, Vercel, and OpenWorkflow provide different storage and execution
systems. ViteHub keeps the Definition and server API the same, while the
selected host integration writes the provider output. Read [Workflow hosts](/docs/workflows/hosts)
before choosing a provider and [Workflow limits and errors](/docs/workflows/limits-and-errors)
when designing retries.

The [Workflow server API](/docs/workflows/server-api) is the contract for
starting runs, reading status, and returning results.
