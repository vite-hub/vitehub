---
title: ViteHub docs
description: Choose ViteHub Agents or ViteHub Server Primitives, then follow one focused path.
navigation: false
icon: i-lucide-book-open
---

ViteHub is one platform with two product lanes. **ViteHub Agents** define, invoke, and deploy server-side Agents. **ViteHub Server Primitives** give Vite applications stable server APIs with package-specific runtime and host integrations.

Agents may compose Server Primitives through explicit Capabilities and Workspaces. Server Primitives work without an Agent Definition.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Agents
  description: Define Agents, attach Capabilities and Workspaces, run Agent Invocations, and inspect behavior.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
  :::u-page-card
  ---
  title: Server Primitives
  description: Use Auth, Env, KV, Database, Blob, Workspace, Queue, Workflow, Schedule, Sandbox, and Shell from server code.
  icon: i-lucide-server-cog
  to: /docs/server-primitives
  ---
  :::
  :::u-page-card
  ---
  title: Start
  description: Install the packages for one lane and reach a visible first success.
  icon: i-lucide-rocket
  to: /docs/getting-started
  ---
  :::
  :::u-page-card
  ---
  title: Shared concepts
  description: Learn Definitions, discovery, Provider Output, Runtime Helpers, Workspaces, Sources, and Capabilities.
  icon: i-lucide-map
  to: /docs/concepts
  ---
  :::
::

## Pick the right section

| You are building | Start with |
| --- | --- |
| A fresh installation or first proof path | [Start](/docs/getting-started) |
| The difference between Definitions, Runtime Helpers, Provider Output, Capabilities, Workspaces, and Sources | [Concepts](/docs/concepts) |
| Application user identity, storage, background work, schedules, sandboxes, or environment handling | [Server primitives](/docs/server-primitives) |
| Model-backed server actors, Agent Invocations, triggers, Chat History, evals, or CLI inspection | [Agents](/docs/agents) |
| Model-facing storage, Workspace, MCP, web search, transcription, rate limits, or product abilities | [Capabilities](/docs/capabilities) |
| Current host support, generated output, provisioning, or live-proof maturity | [Runtime and host support](/docs/frameworks-hosts/support-matrix) |

## The repeated shape

Most ViteHub features follow the same shape:

1. Start with [Installation](/docs/getting-started/installation).
2. Install `vite-hub` for an application, or an owner package for a focused library integration.
3. Register `vitehub()` for the framework distribution, or the owner package's
   `hubX()` integration when a focused composition needs one.
4. Define named work when the primitive needs a Definition.
5. Let the integration generate Provider Output when the package supports the selected host.
6. Call a stable Runtime Helper from server code.
7. Attach a Capability only when an Agent should receive a model-facing ability.

Agents use the same primitives through stricter boundaries. An Agent does not receive every server primitive by default, and a Capability does not mutate primitive configuration dynamically.

## Choose a runtime boundary

Stable imports do not mean that every primitive runs on every host. Check the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) for app-facing helpers, local providers, generated Provider Output, Provision coverage, and current proof maturity.

Read [Concepts](/docs/concepts) for the shared vocabulary, or open [Installation](/docs/getting-started/installation) for a runnable path.
