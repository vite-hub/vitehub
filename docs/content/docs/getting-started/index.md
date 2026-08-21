---
title: Introduction
description: Choose the ViteHub layer that matches the first thing you need to build.
navigation.title: Introduction
navigation.order: 1
icon: i-lucide-rocket
---

ViteHub is a server layer for Vite with two ways in. Server Primitives give
application code stable APIs for infrastructure, while Agents compose those
primitives with models, coding providers, or application-owned logic.

Agents can use Server Primitives. Server Primitives also work on their own.
Start with the path that matches the result your product needs today.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Build with Server Primitives
  description: Add local KV and return one value from an ordinary server route.
  icon: i-lucide-server-cog
  to: /docs/getting-started/first-server-primitive
  ---
  :::
  :::u-page-card
  ---
  title: Build an Agent
  description: Define a deterministic Agent and run one observable Agent Invocation.
  icon: i-lucide-bot
  to: /docs/getting-started/first-agent
  ---
  :::
::

## Choose a first path

Start with Server Primitives when application code needs Auth, Env, KV,
Database, Blob, Workspace, Queue, Workflow, Schedule, Sandbox, or Shell
behavior. The application calls a small Runtime Helper, and the Vite
Integration owns the selected provider.

Start with Agents when the product needs a named server-side actor. An Agent
Definition keeps its Agent Driver, instructions, Capabilities, Workspace, and
runtime behavior visible in one place.

| You want to build | Start here |
| --- | --- |
| Settings, feature flags, caches, cursors, or small lookup records | [First Server Primitive](/docs/getting-started/first-server-primitive) |
| A support actor, code actor, research actor, or workspace-aware assistant | [First Agent](/docs/getting-started/first-agent) |
| Relational data, uploads, background work, workflows, schedules, or sandboxes | [Server Primitives](/docs/server-primitives) |
| Model-facing tools, guarded product abilities, or chat entry points | [Capabilities](/docs/capabilities) |

## How the pieces fit

Most ViteHub features repeat the same small set of boundaries:

| Surface | What it owns |
| --- | --- |
| Vite Integration | Discovers Definitions, resolves Integration Options, and prepares generated output. |
| Definition | Declares named work or state, such as an Agent, Workspace, Queue, Workflow, or Schedule. |
| Runtime Registry | Maps discovered names to lazy-loaded Definitions. |
| Provider Output | Emits host-specific bindings, routes, functions, crons, or runtime files. |
| Runtime Helper | Gives server code a stable API such as `kv`, `useWorkspace()`, or `runAgent()`. |
| Capability | Gives an Agent a named model-facing ability such as `workspaceShell()` or `kv()`. |

The provider boundary stays explicit. Product code uses ViteHub language, while
the integration and Provider Output expose the host-specific details that
actually apply.

## What to inspect

Look for the Vite Integration in `vite.config.ts`, the discovered Definition,
generated `.vitehub` files when a package emits them, and the Runtime Helper
call in server code. Each first-success guide ends with an observable response
so you can prove the boundary before adding more features.

## Next steps

- Read [Installation](/docs/getting-started/installation) to start with the framework distribution or choose a direct owner package for advanced composition.
- Read [Migrate to `vite-hub`](/docs/getting-started/migration) when an existing app uses `@vite-hub/vite` or direct owner-package imports.
- Follow the longer [Server Primitives tutorial](/blog/server-primitives).
- Follow the longer [Agents tutorial](/blog/agents).
- Open [Concepts](/docs/concepts) when you need the full runtime model.
