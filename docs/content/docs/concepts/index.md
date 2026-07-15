---
title: Overview
description: Learn the ViteHub concepts that connect server primitives, agents, integrations, and runtime inspection.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-map
---

ViteHub is easiest to understand as a small set of boundaries. Server primitives give application code stable runtime APIs, while Agent Definitions compose Agent Drivers, Capabilities, Workspaces, Sources, Agent Invokers, and Agent Invocations.

The concepts in this section explain those boundaries before the package pages add options and examples. Read them when a feature crosses package ownership, host output, Agent access, or runtime inspection.

## Concept map

| Concept | Use it to understand |
| --- | --- |
| [Server primitives for any host](/docs/concepts/server-primitives-for-any-host) | Why ViteHub starts from host-independent server behavior. |
| [How ViteHub fits together](/docs/concepts/how-vitehub-fits-together) | How Vite Integrations, Definitions, Provider Output, Runtime Helpers, and Capabilities connect. |
| [Definitions and discovery](/docs/concepts/definitions-and-discovery) | How package-owned files become named runtime behavior. |
| [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) | What build and dev integrations own. |
| [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) | Why application code imports stable ViteHub APIs instead of generated internals. |
| [Workspace and Sources](/docs/concepts/workspace-and-sources) | How persistent file trees consume read-only origins. |
| [Capabilities API](/docs/concepts/capabilities-api) | How Agents receive selected abilities. |
| [Channels API](/docs/concepts/channels-api) | How message-shaped Agent Invocations, channel metadata, and host commands stay separate. |
| [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) | How authenticated app users map into trusted Agent Invocation identity. |
| [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) | How ViteHub records runtime decisions without making policy invisible. |

## Reading order

Start with the first three pages when you are new to the project. Jump to Workspace, Capabilities, Auth, or runtime policy when you are adding those surfaces to an Agent Definition.

## Next steps

- Continue with [Server primitives for any host](/docs/concepts/server-primitives-for-any-host).
- Open [Installation](/docs/getting-started/installation) when you want a runnable setup.
- Open [Server primitives](/docs/server-primitives) or [Agents](/docs/agents) when you already know the boundary you need.
