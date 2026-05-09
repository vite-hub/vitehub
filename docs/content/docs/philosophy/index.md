---
title: ViteHub philosophy
description: Understand how ViteHub packages compose without becoming one central runtime.
navigation.title: Philosophy
icon: i-lucide-network
---

ViteHub is a set of small server primitives. Each package owns one job and exposes a narrow API for that job.

The packages compose through explicit inputs, serializable state, and runtime context. They do not share one central application runtime.

## Layers

| Layer | Packages and entrypoints | Responsibility |
| --- | --- | --- |
| Capabilities | KV, DB, Blob, Queue, Sandbox, Shell, Workspace | Provide scoped access to storage, delivery, execution, and files. |
| Orchestrators | Agent, Workflow | Coordinate model calls, tools, waits, retries, and durable steps. |
| Interfaces | Chat, HTTP routes, webhooks, queue consumers | Receive outside input and call the primitive that owns the work. |
| State | Messages | Store portable conversation and stream state. |

This split keeps the boundaries clear. Chat receives events. Agent runs model and tool loops. Workflow coordinates durable work. Sandbox executes isolated jobs. Messages stores the conversation shape that moves between them.

## Capabilities stay scoped

A capability is an explicit handle to something the current runtime can do.

Examples:

- KV handles key-based state.
- Blob handles file-shaped data.
- Queue handles background delivery.
- Sandbox handles isolated execution.
- Shell handles policy-controlled command execution.
- Workspace handles files and source collections.

Code should receive the handle it needs instead of reaching through provider globals. That makes the same primitive usable across Vite, Nitro, Cloudflare, and Vercel.

## Orchestrators coordinate

Agent owns model selection, instructions, tools, and conversion between ViteHub messages and model calls.

Workflow owns durable orchestration: start, resume, wait, retry, and read run state.

An agent can use capabilities. A workflow can call an agent. They still keep separate responsibilities.

## Interfaces adapt

Chat owns Chat SDK adapters, webhook handling, conversation state, and thread responses.

HTTP routes, webhooks, and queue consumers follow the same rule: validate input, call the primitive that owns the work, and return a result the caller can handle.

## State stays portable

`@vitehub/messages` is the message and stream-event format shared by Chat and Agent. Persist it as structured data. Convert provider-specific objects at the edge.

Portable state should avoid runtime-only values, provider SDK objects, functions, symbols, `undefined`, and un-serialized dates.

## API vocabulary

ViteHub packages use a small vocabulary:

| Verb | Meaning |
| --- | --- |
| `define*` | Declare a primitive. |
| `run*` | Execute a primitive. |
| `get*` or `use*` | Read scoped runtime access. |
| `create*` | Build a runtime adapter or disposable object. |

When a feature crosses package boundaries, pass a typed handle or serializable state. Do not merge the packages into one abstraction.
