---
title: Introduction
description: Choose the ViteHub layer that matches the first thing you need to build.
navigation.title: Introduction
navigation.order: 1
icon: i-lucide-rocket
---

ViteHub adds a server layer to Vite. Server Primitives give application code
APIs for storage, background work, auth, and other server features. Agents
combine those APIs with models, coding providers, or application code.

Agents can use Server Primitives. Server Primitives also work on their own.
Start with the path that matches the result your product needs today.

::u-page-grid{class="not-prose mt-8 sm:grid-cols-2"}
  :::u-page-card
  ---
  title: Use a Server Primitive
  description: Store a value in local KV and read it from a server route.
  icon: i-lucide-server-cog
  to: /docs/getting-started/first-server-primitive
  ---
  :::
  :::u-page-card
  ---
  title: Run an Agent
  description: Define an Agent and inspect the result of one invocation.
  icon: i-lucide-bot
  to: /docs/getting-started/first-agent
  ---
  :::
::

## Choose a first path

Start with Server Primitives when application code needs auth, environment
values, storage, files, background work, or isolated execution. Your server
code calls the ViteHub API, and the Vite integration connects it to the
selected provider.

Start with Agents when the product needs a named server-side actor. An Agent
Definition puts its instructions, execution method, Capabilities, and
Workspace in one file.

| You want to build | Start here |
| --- | --- |
| Settings, feature flags, caches, cursors, or small records | [First Server Primitive](/docs/getting-started/first-server-primitive) |
| A support, coding, research, or workspace-aware actor | [First Agent](/docs/getting-started/first-agent) |
| Relational data, uploads, background work, workflows, schedules, or sandboxes | [Server Primitives](/docs/server-primitives) |
| Model-facing tools, guarded product abilities, or chat entry points | [Capabilities](/docs/capabilities) |

## What ViteHub does

Most features use the same path:

| Part | What it does |
| --- | --- |
| Vite integration | Finds definitions and prepares the selected provider during development and build. |
| Definition | Declares named work or state, such as an Agent, Workspace, Queue, Workflow, or Schedule. |
| Server API | Lets application code call a feature through an import such as `kv`, `useWorkspace()`, or `runAgent()`. |
| Capability | Lets an Agent use a selected operation such as `workspaceShell()` or `kv()`. |

Application code uses ViteHub imports. The integration handles the
provider-specific routes, bindings, and files.

## Verify your setup

Check the ViteHub plugin in `vite.config.ts`, the definition file when the
feature needs one, and the ViteHub call in server code. Each first guide ends
with a response you can inspect before adding another feature.

## Next steps

- Read [Installation](/docs/getting-started/installation) to start with the framework distribution or choose a direct owner package for advanced composition.
- Follow the longer [Server Primitives tutorial](/blog/server-primitives).
- Follow the longer [Agents tutorial](/blog/agents).
- Open [Concepts](/docs/concepts) when you need the full runtime model.
