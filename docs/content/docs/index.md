---
title: ViteHub docs
description: Add server APIs or portable Agents to a Vite application.
navigation: false
icon: i-lucide-book-open
---

ViteHub adds a server layer to Vite. Use **Server Primitives** directly from application code, or combine them with models and tools in an **Agent**.

Server Primitives work without an Agent. When you build an Agent, Capabilities control which operations it can use.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Server primitives
  description: Add auth, storage, queues, schedules, sandboxes, and other server APIs.
  icon: i-lucide-server-cog
  to: /docs/server-primitives
  ---
  :::
  :::u-page-card
  ---
  title: Agents
  description: Define an Agent, select its Capabilities and Workspace, then run and inspect it.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
  :::u-page-card
  ---
  title: Get started
  description: Install ViteHub and run one Server Primitive or Agent.
  icon: i-lucide-rocket
  to: /docs/getting-started
  ---
  :::
  :::u-page-card
  ---
  title: Concepts
  description: Learn how definitions, integrations, Workspaces, Sources, and Capabilities fit together.
  icon: i-lucide-map
  to: /docs/concepts
  ---
  :::
::

## Find what you need

| You are building | Start with |
| --- | --- |
| A new installation | [Get started](/docs/getting-started) |
| Auth, storage, background work, schedules, sandboxes, or environment values | [Server primitives](/docs/server-primitives) |
| Model-backed actors, Agent Invocations, triggers, chat history, evals, or CLI inspection | [Agents](/docs/agents) |
| Tools and product operations that an Agent can use | [Capabilities](/docs/capabilities) |
| The difference between definitions, server APIs, Workspaces, Sources, and Capabilities | [Concepts](/docs/concepts) |
| Host support, generated output, or deployment support | [Runtime and host support](/docs/frameworks-hosts/support-matrix) |

## How ViteHub connects your code to a host

Most features use this path:

1. Start with [Installation](/docs/getting-started/installation).
2. Register `vitehub()` in the Vite configuration.
3. Add a definition when the feature needs a name, schema, or reusable configuration.
4. Call the documented server API from application code.
5. Attach a Capability if an Agent needs to call that operation.

The Vite integration discovers definitions and prepares the provider-specific files for the selected host. Application code keeps using ViteHub imports.

## Check host support

Not every Server Primitive runs on every host. Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) before you choose a deployment target.

Open [Installation](/docs/getting-started/installation) for a runnable path, or read [Concepts](/docs/concepts) when you need the runtime model.
