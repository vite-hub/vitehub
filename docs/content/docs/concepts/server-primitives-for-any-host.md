---
title: Server primitives for any host
description: Understand the host-independent server layer that ViteHub packages provide.
navigation.order: 2
icon: i-lucide-server-cog
---

Server primitives are ViteHub-owned runtime behaviors that application code can use without creating an Agent. They cover authentication, environment values, storage, file trees, background work, schedules, workflows, sandboxes, queues, and related runtime surfaces.

The primitive owns the app-facing contract. A host provider may supply storage, bindings, functions, or runtime execution, but the server route should keep importing the same ViteHub Runtime Helper.

## Why it exists

Vite apps often need the same server behavior across local development, Cloudflare, Vercel, Node, and framework-specific hosts. ViteHub keeps the public API at the primitive boundary so application code does not learn every provider's wiring model.

This also keeps agents honest. An Agent can use a primitive only when an attached Capability exposes an ability for that primitive.

## What primitives own

| Primitive family | Owns | Does not own |
| --- | --- | --- |
| Storage | KV, Database, Blob, Workspace Stores, and file-tree behavior. | Product-specific data modeling or UI workflows. |
| Runtime work | Queue, Workflow, Schedule, Sandbox, and Shell execution boundaries. | Every app-level process manager or dashboard. |
| Identity and configuration | Auth, Env, Server Env, Public Env, and Secret Env handling. | Login UI, route design, or provider dashboards. |
| Agents | Agent Definitions, Agent Invocations, Agent Drivers, Capabilities, and runtime composition. | Unrestricted access to every primitive. |

## How it fits

Each primitive package can expose a Vite Integration, Runtime Helper, Definition Boundary Helper, and Provider Output. Small primitives such as KV can often run after configuration. Definition-heavy primitives such as Workflows, Queues, Workspaces, Schedules, and Agents use discovery so named work can be inspected and invoked.

## Inspect it

Look for three files or surfaces:

- `vite.config.ts`, where the package's Vite Integration is registered.
- The primitive page, where package-owned configuration and Provider Output are documented.
- The server route or worker code that imports the stable Runtime Helper.

## Next steps

- Read [How ViteHub fits together](/docs/concepts/how-vitehub-fits-together).
- Try [First server primitive](/docs/getting-started/first-server-primitive).
- Open [Server primitives](/docs/server-primitives) for the package pages.
