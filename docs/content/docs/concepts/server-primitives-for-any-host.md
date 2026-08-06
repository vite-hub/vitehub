---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

Server Primitives are APIs that application code calls to work with server-side artifacts such as environment values, databases, queues, workflows, files, and sandboxes.

ViteHub automatically adapts the primitive for local development and for your deployment host, whether that's Cloudflare, Vercel, Docker, or another provider.

## Choose a Server Primitive when application code owns the action

| You need | Start with |
| --- | --- |
| Read configuration or secrets | [Env](/docs/server-primitives/env) |
| Store application data | [Database](/docs/server-primitives/database) or [KV](/docs/server-primitives/kv) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Persist files or expose read-only origins | [Workspace](/docs/server-primitives/workspace) and [Source](/docs/server-primitives/source) |
| Run isolated commands or code | [Shell](/docs/server-primitives/shell) or [Sandbox](/docs/server-primitives/sandbox) |

## Agent Primitives use LLMs to run actions on demand

An Agent Primitive is a special kind of primitive that uses an LLM to choose and run tools or actions on demand. An Agent receives selected Capabilities and can decide which of those capabilities to invoke during an Agent Invocation.

The application still decides which Capabilities an Agent can access. Attaching a Capability makes that access explicit and inspectable.

## Inspect the boundary

Look for the package's Vite Integration, Runtime Helper, and generated Provider Output. The primitive page documents the package contract; the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) shows where that contract is currently proven.

Continue with [From Definition to Invocation](/docs/concepts/how-vitehub-fits-together) for the complete flow, or open [First server primitive](/docs/getting-started/first-server-primitive) to build one.
