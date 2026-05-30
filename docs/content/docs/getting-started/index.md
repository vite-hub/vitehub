---
title: Getting started
description: Install ViteHub, choose a documentation path, and run your first primitive or agent.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-rocket
---

ViteHub has one setup flow and two product paths.

Use **Server primitives** when your app needs storage, background work, schedules, sandboxes, queues, workspace files, or runtime environment values.

Use **Agents** when your app needs model-backed actors with instructions, invocations, triggers, workspace context, evaluations, and controlled capabilities.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: Installation
  description: Add the packages you need and register their ViteHub integrations.
  icon: i-lucide-download
  to: /docs/getting-started/installation
  ---
  :::
  :::u-page-card
  ---
  title: First server primitive
  description: Add KV and call it from ordinary server code.
  icon: i-lucide-server-cog
  to: /docs/getting-started/first-server-primitive
  ---
  :::
  :::u-page-card
  ---
  title: First agent
  description: Define an Agent and run one invocation from a server route.
  icon: i-lucide-bot
  to: /docs/getting-started/first-agent
  ---
  :::
::

## Choose the first path

| You want to build | Start here |
| --- | --- |
| App settings, flags, caches, or small lookup records | [First server primitive](/docs/getting-started/first-server-primitive) |
| Relational data, uploads, background work, workflows, or sandboxes | [Server primitives](/docs/server-primitives) |
| A support agent, code agent, research agent, or workspace-aware assistant | [First agent](/docs/getting-started/first-agent) |
| Custom model-facing tools or guarded product abilities | [Agent capabilities](/docs/agents/capabilities) |

## Package shape

ViteHub keeps packages small, but the docs are organized by user intent. Install the package that owns the feature you use, then stay in the feature page for host configuration, runtime behavior, and examples.

Cloudflare, Vercel, local, and other host behavior lives inside the feature it changes. There is no separate docs path for host setup.
