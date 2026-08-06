---
title: Concepts
description: Learn the ViteHub terms that help you choose an API and understand what runs where.
navigation.title: Overview
navigation.order: 1
navigation: false
icon: i-lucide-map
---

This section is a glossary for developers building server features and Agents with ViteHub. Each page answers one question: what does this term mean, where does it run, or how is it different from the nearest term?

Use the [Server primitives](/docs/server-primitives), [Agents](/docs/agents), [Capabilities](/docs/capabilities), and [Reference](/docs/reference) sections for package APIs, setup instructions, and exact options.

## Start here

| Page | Read it when |
| --- | --- |
| [Server primitives](/docs/concepts/server-primitives-for-any-host) | You need a database, message channel, background job, storage layer, or another server feature. |
| [Agents](/docs/agents) | You need model execution, Agent Definitions, Capabilities, or Agent Invocations. |

## Core vocabulary

| Page | Defines |
| --- | --- |
| [Definition discovery](/docs/concepts/definitions-and-discovery) | How a file becomes a named ViteHub definition. |
| [Agent Invocations](/docs/concepts/agent-invocations) | What ViteHub resolves and records for one Agent request. |
| [Capabilities](/docs/concepts/capabilities-api) | How an Agent receives a selected ability. |
| [Workspace and Sources](/docs/concepts/workspace-and-sources) | How persistent files differ from read-only origins. |
| [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) | How application identity becomes trusted invocation identity. |
| [Channels](/docs/concepts/channels-api) | How messages, delivery facts, and host commands reach an Agent. |
| [Bash](/docs/concepts/bash) | How Capability-provided commands appear as one Agent tool. |

## Runtime execution

| Page | Defines |
| --- | --- |
| [Runtime Context](/docs/concepts/runtime-context) | The host resources passed into a server operation or Agent request. |
| [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) | The imports application code uses to call ViteHub. |
| [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces) | The records that explain whether work ran, waited, or failed. |

## Host and build model

| Page | Defines |
| --- | --- |
| [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) | How ViteHub prepares a package for development and deployment. |

## Choose between

Use these pages when two terms sound similar but lead to different APIs.

- [Server Primitive vs Capability](/docs/concepts/server-primitives-vs-capabilities)
- [Workspace vs Source](/docs/concepts/workspace-vs-source)
- [Auth User vs Agent Invoker](/docs/concepts/auth-user-vs-agent-invoker)
- [Channel vs Agent Invocation](/docs/concepts/channel-vs-agent-invocation)

## Choose your next page

Start with [Installation](/docs/getting-started/installation) when you want a runnable project. Read [Server primitives](/docs/server-primitives) or [Agents](/docs/agents) when you already know what you want to build.
