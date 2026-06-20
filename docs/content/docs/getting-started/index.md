---
title: Introduction
description: Learn the ViteHub shape before installing a server primitive or defining an agent.
navigation.title: Introduction
navigation.order: 1
icon: i-lucide-rocket
---

ViteHub provides server primitives for any host and Agent Definitions for model-backed server actors. It keeps host-specific wiring behind Vite Integrations, generated Provider Output, and stable Runtime Helpers.

Start with server primitives when application code needs Auth, Env, KV, Database, Blob, Workspace, Queue, Workflow, Schedule, Sandbox, or Shell behavior. Start with agents when the product needs Agent Invocations, model-backed execution, Chat History, Workspace context, or model-facing Capabilities.

The route directory is still `getting-started`, but the visible section is **Start**.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Installation
  description: Add the packages you need and register their Vite Integrations.
  icon: i-lucide-download
  to: /docs/getting-started/installation
  ---
  :::
  :::u-page-card
  ---
  title: First agent
  description: Define one Agent and run one Agent Invocation from a server route.
  icon: i-lucide-bot
  to: /docs/getting-started/first-agent
  ---
  :::
  :::u-page-card
  ---
  title: First server primitive
  description: Add KV and call its Runtime Helper from ordinary server code.
  icon: i-lucide-server-cog
  to: /docs/getting-started/first-server-primitive
  ---
  :::
::

## How ViteHub works

Most ViteHub features repeat the same shape:

| Surface | What it owns |
| --- | --- |
| Vite Integration | Discovers Definitions, resolves Integration Options, and prepares generated output. |
| Definition | Declares named work or state, such as an Agent, Workspace, Queue, Workflow, or Schedule. |
| Runtime Registry | Maps discovered names to lazy-loaded Definitions for runtime use. |
| Provider Output | Emits host-specific bindings, routes, functions, crons, or runtime files. |
| Runtime Helper | Gives server code a stable API such as `kv`, `useWorkspace()`, or `runAgent()`. |
| Capability | Gives an Agent a named model-facing ability such as `workspaceShell()` or `kv()`. |

## Choose a first path

| You want to build | Start here |
| --- | --- |
| App settings, feature flags, caches, cursors, or small lookup records | [First server primitive](/docs/getting-started/first-server-primitive) |
| A support agent, code agent, research agent, or workspace-aware assistant | [First agent](/docs/getting-started/first-agent) |
| Relational data, uploads, background work, workflows, schedules, or sandboxes | [Server primitives](/docs/server-primitives) |
| Custom model-facing tools, guarded product abilities, or chat entry points | [Capabilities](/docs/capabilities) |

## What to inspect

Agents and developers should be able to inspect what ViteHub creates. Look for the Vite Integration in `vite.config.ts`, the discovered Definition file, generated `.vitehub` files when a package emits them, and the Runtime Helper call in server code.

Host behavior stays with the primitive that owns it. Cloudflare, Vercel, local development, and Nuxt handoff details appear on the feature pages they affect.

## Next steps

- Continue with [Installation](/docs/getting-started/installation) to add the first package.
- Open [Concepts](/docs/concepts) to learn the boundaries before writing production code.
- Continue with [First agent](/docs/getting-started/first-agent) or [First server primitive](/docs/getting-started/first-server-primitive).
