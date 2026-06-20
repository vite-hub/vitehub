---
title: Server primitives
description: Use ViteHub primitives directly from app and server code, then expose them to agents only when needed.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-server-cog
---

Server primitives are ViteHub-owned server capabilities for ordinary application code. They give routes, handlers, jobs, and workers stable Runtime Helpers for auth, storage, file trees, source retrieval, runtime work, schedules, isolated execution, command execution, and environment values.

Agents can use the same primitives through Capabilities, but primitives do not require an Agent Definition. Start with the server API that your app needs, then attach an agent-facing Capability only when a model should read, write, invoke, or inspect that primitive.

## Primitive map

| Primitive | Use it for |
| --- | --- |
| [Env](/docs/server-primitives/env) | Public Env, Server Env, Build Env, Runtime Env, and Secret Env values. |
| [Auth](/docs/server-primitives/auth) | Better Auth server routing, sessions, Auth Database Placement, and guarded app routes. |
| [KV](/docs/server-primitives/kv) | Small key-addressed values and lightweight state. |
| [Database](/docs/server-primitives/database) | Drizzle-backed relational data, Default Databases, Named Databases, and generated schema. |
| [Blob](/docs/server-primitives/blob) | Object storage for uploads, generated artifacts, binary files, and metadata. |
| [Workspace](/docs/server-primitives/workspace) | Persistent file trees with rules, snapshots, diffs, Source Bindings, and sessions. |
| [Source](/docs/server-primitives/source) | Typed read-only retrieval from files, globs, GitHub, markdown, MCP resources, or custom loaders. |
| [Queue](/docs/server-primitives/queue) | Background Queue Enqueue and provider-driven Queue Delivery. |
| [Workflows](/docs/server-primitives/workflows) | Durable Workflow Runs with provider-tracked orchestration and optional Workflow Steps. |
| [Schedule](/docs/server-primitives/schedule) | Static cron Schedule Definitions and recurring Runtime Schedules. |
| [Sandbox](/docs/server-primitives/sandbox) | Isolated Sandbox Runs for named execution work. |
| [Shell](/docs/server-primitives/shell) | Controlled Shell Runtime sessions over explicit filesystem and execution boundaries. |

## Use primitives from server code

Most primitives expose one stable import for application code. The route calls the Runtime Helper; provider wiring stays in the package integration and Provider Output.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

That route does not know whether the backing KV Store uses local files, Cloudflare, Vercel, or another driver. The primitive owns the provider boundary.

## Definitions, registries, and provider output

Some primitives work directly after configuration. Env, KV, Blob, Source, and Shell can often be called from server code without a discovered Definition.

Other primitives need a Definition so ViteHub can discover named work, generate a Runtime Registry, and produce host-specific Provider Output. Database schemas, Workspace Definitions, Queue Definitions, Workflow Definitions, Static Schedule Definitions, Sandbox Definitions, and Agent Definitions use that model.

Read [Definitions and discovery](/docs/concepts/definitions-and-discovery) for the shared discovery model. Read [Server primitives for any host](/docs/concepts/server-primitives-for-any-host) for the broader mental model.

## Connect primitives to agents

Capabilities expose controlled agent-facing access to primitives. A storage Capability can expose scoped read/edit tools, a Schedule Capability can manage allowed Runtime Schedules, and `workspaceShell()` can expose file inspection through Workspace and Shell boundaries.

Do not expose a primitive to a model just because the app uses it. Attach the relevant [Official Capability](/docs/capabilities/official-capabilities) only when the Agent needs that ability, then keep scopes, write modes, and approvals explicit.

## Next steps

- Build the first direct primitive with [First server primitive](/docs/getting-started/first-server-primitive).
- Learn the shared mental model in [How ViteHub fits together](/docs/concepts/how-vitehub-fits-together).
- Expose primitive access to agents through [Official capabilities](/docs/capabilities/official-capabilities).
