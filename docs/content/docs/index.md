---
title: ViteHub docs
description: Build server primitives directly in your app, or compose them into agents with controlled capabilities.
navigation: false
icon: i-lucide-book-open
---

ViteHub has two documentation paths.

Use **Server primitives** when you want storage, background work, schedules, sandboxes, or environment handling in ordinary server code.

Use **Agents** when you want to define model-backed actors with instructions, workspaces, triggers, evaluations, and model-facing capabilities.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Getting started
  description: Install ViteHub, choose the right path, and run your first primitive or agent.
  icon: i-lucide-rocket
  to: /docs/getting-started
  ---
  :::
  :::u-page-card
  ---
  title: Server primitives
  description: Use KV, Database, Blob, Workspace, Queue, Workflow, Schedule, Sandbox, and Env without creating an agent.
  icon: i-lucide-server-cog
  to: /docs/server-primitives
  ---
  :::
  :::u-page-card
  ---
  title: Agents
  description: Define agents, attach capabilities, give them workspace context, and inspect how they run.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
::

## Pick the right path

| You are building | Start with |
| --- | --- |
| App settings, flags, cache entries, or small lookup state | [KV](/docs/server-primitives/kv) |
| Relational application data, joins, migrations, or history | [Database](/docs/server-primitives/database) |
| Uploads, generated assets, PDFs, images, or binary objects | [Blob](/docs/server-primitives/blob) |
| File-tree state, source ingestion, snapshots, or diffs | [Workspace and Sources](/docs/server-primitives/workspace) |
| Work that should run after the response returns | [Queue](/docs/server-primitives/queue) |
| Durable work with waits, retries, and resumable state | [Workflow](/docs/server-primitives/workflow) |
| Future or recurring runtime work | [Schedule](/docs/server-primitives/schedule) |
| Isolated code execution | [Sandbox](/docs/server-primitives/sandbox) |
| A model-backed server actor | [Agents](/docs/agents) |

## The repeated shape

Most ViteHub features follow the same shape:

1. Start with [Installation](/docs/getting-started/installation).
2. Install the package that owns the primitive or Agent surface.
3. Register the package's Vite Integration in `vite.config.ts`.
4. Define named work when the primitive needs a Definition.
5. Keep host-specific output and credentials in configuration.
6. Call a stable Runtime Helper from server code.

Agents use the same primitives, but through a stricter boundary. An agent does not receive every server primitive by default. You attach a Capability when the model should be able to use one.

## What changed in this docs model

The documentation is not organized by package directories. Package boundaries still exist in code, but the docs are organized by user intent:

- Server primitives for application developers.
- Agents for developers creating model-backed server actors.
- Capability docs only inside Agents, because capabilities are how agents receive abilities.
