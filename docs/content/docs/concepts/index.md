---
title: Concepts
description: "Learn the small set of ViteHub terms that connect server primitives, Agents, hosts, and runtime execution."
navigation.title: Overview
navigation.order: 1
icon: i-lucide-map
---

Concepts are ViteHub's shared vocabulary. Each page defines one term or one boundary so you can understand the product before choosing an API.

These pages stay short and compositional. Use [Server primitives](/docs/server-primitives), [Agents](/docs/agents), [Capabilities](/docs/capabilities), and [Reference](/docs/reference) for complete API options and operational instructions.

## Start here

| Page | Read it when |
| --- | --- |
| [Server primitives](/docs/concepts/server-primitives-for-any-host) | You need application infrastructure without creating an Agent. |

## Core vocabulary

| Page | Defines |
| --- | --- |
| [Definition discovery](/docs/concepts/definitions-and-discovery) | How named ViteHub declarations become inspectable runtime entries. |
| [Agent Invocations](/docs/concepts/agent-invocations) | One request to one Agent, including its input, identity, abilities, and result. |
| [Capabilities](/docs/concepts/capabilities-api) | How an Agent receives selected model-facing abilities. |
| [Workspace and Sources](/docs/concepts/workspace-and-sources) | The difference between a persistent file tree and a read-only origin. |
| [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) | Application identity versus trusted invocation identity. |
| [Channels](/docs/concepts/channels-api) | Message origin, delivery facts, and the invocation started by a channel. |
| [Bash](/docs/concepts/bash) | The single constrained executable surface contributed by Capabilities. |

## Runtime execution

| Page | Defines |
| --- | --- |
| [Runtime Context](/docs/concepts/runtime-context) | Host-owned execution facts passed into a ViteHub operation. |
| [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) | The application-facing API boundary for calling ViteHub primitives. |
| [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) | How runtime decisions become inspectable records. |

## Host and build model

| Page | Defines |
| --- | --- |
| [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) | How package declarations become host-specific build output. |

## Choose between

These pages answer the distinctions that otherwise make ViteHub's vocabulary look larger than it is.

- [Server Primitive vs Capability](/docs/concepts/server-primitives-vs-capabilities)
- [Workspace vs Source](/docs/concepts/workspace-vs-source)
- [Auth User vs Agent Invoker](/docs/concepts/auth-user-vs-agent-invoker)
- [Channel vs Agent Invocation](/docs/concepts/channel-vs-agent-invocation)

## Keep the layers separate

Concepts explain the product language. Guides show how to complete a task. Reference pages list exact options and constraints. ADRs record hard-to-reverse decisions. Keeping those jobs separate makes each page easier for people and Agents to use.

Start with [Installation](/docs/getting-started/installation) when you want a runnable project, or jump to [Server primitives](/docs/server-primitives) and [Agents](/docs/agents) when you already know which lane you need.
