---
title: Workflow concepts
description: Learn workflow runs, durable steps, retries, and provider state before you design a long-running job.
navigation.title: Concepts
navigation.order: 8
navigation.group: Concepts
icon: i-lucide-lightbulb
---

A Workflow turns one request into a run that the provider tracks. Starting it returns a run id. Later calls use the id to read the status or result. Store the id with the record that shows progress.

## A run is the durable unit

The workflow file describes the work. The run holds its payload, status, error, and result. A provider can resume a run after a worker or process stops. So when the provider needs it, keep side effects in durable steps.

Use a stable id when the same operation must not start twice. Expect retries, and make external calls safe to repeat.

## Providers own the runtime state

Cloudflare, Vercel, and OpenWorkflow store and run work in different ways. Your workflow and server API stay the same, and ViteHub writes the host files. Read [Workflow hosts](/docs/workflows/hosts) before you choose a provider, and [Workflow limits and errors](/docs/workflows/limits-and-errors) when you design retries.

The [Workflow server API](/docs/workflows/server-api) starts runs, reads status, and returns results.
