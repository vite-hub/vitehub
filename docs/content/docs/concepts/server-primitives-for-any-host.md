---
title: Server primitives
description: Understand the ViteHub runtime APIs that application code can use.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

A Server Primitive gives application code a stable server-side operation such as authentication, environment values, storage, queues, workflows, schedules, sandboxes, or file trees. The application can call a primitive without defining an Agent.

ViteHub keeps the application-facing import stable while a Vite Integration connects the primitive to the local runtime and the deployment host.

## Choose a Server Primitive when application code owns the action

| You need | Start with |
| --- | --- |
| Read configuration or secrets | [Env](/docs/server-primitives/env) |
| Store relational data | [Database](/docs/server-primitives/database) |
| Store small key-value records | [KV](/docs/server-primitives/kv) |
| Persist files or expose read-only origins | [Workspace](/docs/server-primitives/workspace) and [Source](/docs/server-primitives/source) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Run isolated commands or code | [Shell](/docs/server-primitives/shell) or [Sandbox](/docs/server-primitives/sandbox) |

## Server Primitives and Agents solve different problems

Server code calls a Runtime Helper directly. An Agent receives selected abilities through Capabilities and uses them during an Agent Invocation.

Installing a primitive does not expose it to every Agent. Attaching a Capability makes that access explicit and inspectable.

## Inspect the boundary

Look for the package's Vite Integration, Runtime Helper, and generated Provider Output. The primitive page documents the package contract; the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) shows where that contract is currently proven.

Continue with [From Definition to Invocation](/docs/concepts/how-vitehub-fits-together) for the complete flow, or open [First server primitive](/docs/getting-started/first-server-primitive) to build one.
