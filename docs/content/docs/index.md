---
title: ViteHub docs
description: Build server primitives for any host, then compose them into agents with controlled capabilities.
navigation: false
icon: i-lucide-book-open
---

ViteHub is a server layer for Vite apps that need host-independent primitives and inspectable agent infrastructure. It gives application code stable Runtime Helpers and gives Agent Definitions controlled Capabilities instead of raw access to every server resource.

Use Start for the first install, Concepts for the mental model, Server primitives for app-code APIs, and Agents when model-backed behavior becomes part of the product.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Start
  description: Install one package, register its Vite Integration, and run the first primitive or Agent.
  icon: i-lucide-rocket
  to: /docs/getting-started
  ---
  :::
  :::u-page-card
  ---
  title: Concepts
  description: Learn Definitions, discovery, Provider Output, Runtime Helpers, Workspaces, Sources, Capabilities, and Agent Invokers.
  icon: i-lucide-map
  to: /docs/concepts
  ---
  :::
  :::u-page-card
  ---
  title: Server primitives
  description: Use Auth, Env, KV, Database, Blob, Workspace, Queue, Workflow, Schedule, Sandbox, and Shell from server code.
  icon: i-lucide-server-cog
  to: /docs/server-primitives
  ---
  :::
  :::u-page-card
  ---
  title: Agents
  description: Define Agents, attach Capabilities, run Agent Invocations, add Workspace context, and inspect behavior.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
::

## Pick the right section

| You are building | Start with |
| --- | --- |
| A fresh installation or first proof path | [Start](/docs/getting-started) |
| The difference between Definitions, Runtime Helpers, Provider Output, Capabilities, Workspaces, and Sources | [Concepts](/docs/concepts) |
| Application user identity, storage, background work, schedules, sandboxes, or environment handling | [Server primitives](/docs/server-primitives) |
| Model-backed server actors, Agent Invocations, triggers, Chat History, evals, or DevTools inspection | [Agents](/docs/agents) |
| Model-facing storage, Workspace, MCP, web search, transcription, rate limits, or product abilities | [Capabilities](/docs/capabilities) |

## The repeated shape

Most ViteHub features follow the same shape:

1. Start with [Installation](/docs/getting-started/installation).
2. Install the package that owns the primitive or Agent surface.
3. Register the package's Vite Integration in `vite.config.ts`.
4. Define named work when the primitive needs a Definition.
5. Let the integration generate Provider Output when the host needs it.
6. Call a stable Runtime Helper from server code.
7. Attach a Capability only when an Agent should receive a model-facing ability.

Agents use the same primitives through stricter boundaries. An Agent does not receive every server primitive by default, and a Capability does not mutate primitive configuration dynamically.

## Current docs shape

The documentation is organized by public model, not package directories. Package ownership still matters in code, but the sidebar should teach the concepts an agent or developer needs before exposing package internals.

The next useful read is [Concepts](/docs/concepts) if you want the vocabulary, or [Installation](/docs/getting-started/installation) if you want a runnable path.
