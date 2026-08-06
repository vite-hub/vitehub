---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

Server Primitives are APIs that application code calls to work with server-side artifacts such as environment values, databases, queues, workflows, files, and sandboxes.

ViteHub automatically adapts the primitive for local development and for your deployment host, whether that's Cloudflare, Vercel, Docker, or another provider.

## Choose a primitive for the job

| You need | Start with |
| --- | --- |
| Configure the app | [Env](/docs/server-primitives/env), [Auth](/docs/server-primitives/auth), or [Rate Limit](/docs/server-primitives/rate-limit) |
| Store data and files | [Database](/docs/server-primitives/database), [KV](/docs/server-primitives/kv), [Blob](/docs/server-primitives/blob), [Workspace](/docs/server-primitives/workspace), or [Source](/docs/server-primitives/source) |
| Send or receive messages | [Email](/docs/server-primitives/email) or [Channels](/docs/agents/channels) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Run isolated automation | [Browser](/docs/server-primitives/browser), [Shell](/docs/server-primitives/shell), or [Sandbox](/docs/server-primitives/sandbox) |

## Agent Primitives use LLMs to run actions on demand

An Agent Primitive is a special kind of primitive that uses an LLM to choose and run tools or actions on demand. An Agent receives selected Capabilities and can decide which of those capabilities to invoke during an Agent Invocation.

The application still decides which Capabilities an Agent can access. Attaching a Capability makes that access explicit and inspectable.

## Inspect the boundary

Look for the package's Vite Integration, Runtime Helper, and generated Provider Output. The primitive page documents the package contract; the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) shows where that contract is currently proven.

Continue with [From Definition to Invocation](/docs/concepts/how-vitehub-fits-together) for the complete flow, or open [First server primitive](/docs/getting-started/first-server-primitive) to build one.
