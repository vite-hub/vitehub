---
title: Concepts
description: Learn the ViteHub terms that help you choose an API and understand what runs where.
navigation.title: Overview
navigation.order: 1
navigation.group: Start here
navigation: false
icon: i-lucide-map
---

ViteHub adds server features to Vite applications and lets Agents use selected features through Capabilities. These pages explain the terms that connect those two paths.

For setup and API options, go to [Server primitives](/docs/server-primitives), [Agents](/docs/agents), [Capabilities](/docs/capabilities), or [Reference](/docs/reference).

## Start here

| Page | Read it when |
| --- | --- |
| [Server primitives](/docs/concepts/server-primitives-for-any-host) | You need storage, background work, auth, isolated execution, or another server feature. |
| [Agents](/docs/agents) | You need a named actor that runs with a model, coding provider, or application code. |

## Core vocabulary

| Page | Defines |
| --- | --- |
| [Definition discovery](/docs/concepts/definitions-and-discovery) | How ViteHub finds and names a definition file. |
| [Agent Invocations](/docs/concepts/agent-invocations) | What ViteHub resolves and records for one Agent request. |
| [Capabilities](/docs/concepts/capabilities-api) | How an Agent receives a selected ability. |
| [Workspace and Sources](/docs/concepts/workspace-and-sources) | How a writable file tree differs from the read-only content mounted into it. |
| [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) | How application identity becomes trusted invocation identity. |
| [Channels](/docs/concepts/channels-api) | How messages, delivery facts, and host commands reach an Agent. |
| [Bash](/docs/concepts/bash) | How Capability-provided commands appear as one Agent tool. |

## Runtime execution

| Page | Defines |
| --- | --- |
| [Runtime Context](/docs/concepts/runtime-context) | The host resources available to a server operation or Agent request. |
| [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) | The imports application code uses to call ViteHub. |
| [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) | The records that explain whether work ran, waited, or failed. |

## Host and build model

| Page | Defines |
| --- | --- |
| [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) | How ViteHub prepares a package for development and deployment. |

## Next steps

Open [Installation](/docs/getting-started/installation) for a runnable project. If you already know what you need, go to [Server primitives](/docs/server-primitives) or [Agents](/docs/agents).
