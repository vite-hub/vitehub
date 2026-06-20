---
title: Server primitives
description: Use ViteHub primitives directly from routes, handlers, jobs, and workers, then expose them to Agents only when needed.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-server-cog
---

## Server primitives for Vite apps and any host

Use ViteHub primitives directly from routes, handlers, jobs, and workers, then expose them to Agents only when needed. Server primitives are useful even when the app has no Agent Definition.

Start here:

- [Build your first server primitive](/docs/getting-started/first-server-primitive)
- [Server primitives for any host](/docs/concepts/server-primitives-for-any-host)
- [Compose primitives into Agents](/docs/agents)

:::note
**Server code gets Runtime Helpers. Agents get Capabilities.** App routes can call stable imports directly, while an Agent Driver receives only the named abilities that Capabilities expose. Read [How ViteHub fits together](/docs/concepts/how-vitehub-fits-together) and [Capabilities API](/docs/concepts/capabilities-api) for the shared model.
:::

## Use primitives from server code

Most primitives expose stable imports for application code. The route calls the Runtime Helper; package integrations and Provider Output own the host wiring.

| Need | Read |
| --- | --- |
| Install the preset Vite Integration and primitive packages | [Installation](/docs/getting-started/installation) |
| Call generated or integration-backed APIs through stable imports | [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) |
| Understand what the Vite Integration emits for each host | [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) |
| Check package and generated import paths | [Import paths](/docs/reference/import-paths) |

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

That route does not know whether the backing KV Store uses local files, Cloudflare, Vercel, or another driver. The primitive owns the provider boundary.

## Primitive map

Grouped by the job you need first, not by package directory.

### Identity and config

| Primitive | Use it for |
| --- | --- |
| [Env](/docs/server-primitives/env) | Public Env, Server Env, Build Env, Runtime Env, and Secret Env values. |
| [Auth](/docs/server-primitives/auth) | Better Auth server routing, sessions, Auth Database Placement, guarded app routes, and the [Auth Users and Agent Invokers](/docs/concepts/auth-users-and-agent-invokers) boundary. |

### Storage, data, and files

| Primitive | Use it for |
| --- | --- |
| [KV](/docs/server-primitives/kv) | Small key-addressed values and lightweight state. |
| [Database](/docs/server-primitives/database) | Drizzle-backed relational data, Default Databases, Named Databases, and generated schema. |
| [Blob](/docs/server-primitives/blob) | Object storage for uploads, generated artifacts, binary files, and metadata. |
| [Workspace](/docs/server-primitives/workspace) | Persistent file trees with rules, snapshots, diffs, Source Bindings, and sessions. |
| [Source](/docs/server-primitives/source) | Typed read-only retrieval from files, globs, GitHub, markdown, MCP resources, or custom loaders. |

### Runtime work and execution

| Primitive | Use it for |
| --- | --- |
| [Queue](/docs/server-primitives/queue) | Background Queue Enqueue and provider-driven Queue Delivery. |
| [Workflows](/docs/server-primitives/workflows) | Durable Workflow Runs with provider-tracked orchestration and optional Workflow Steps. |
| [Schedule](/docs/server-primitives/schedule) | Static cron Schedule Definitions and recurring Runtime Schedules. |
| [Sandbox](/docs/server-primitives/sandbox) | Isolated Sandbox Runs for named execution work. |
| [Shell](/docs/server-primitives/shell) | Controlled Shell Runtime sessions over explicit filesystem and execution boundaries. |

## Primitive showcase

::server-primitive-showcase
::

## Definitions, registries, and provider output

Some primitives work directly after configuration. Env, KV, Blob, Source, and Shell can often be called from server code without a discovered Definition.

Other primitives need a Definition so ViteHub can discover named work, generate a Runtime Registry, and produce host-specific Provider Output. Database schemas, Workspace Definitions, Queue Definitions, Workflow Definitions, Static Schedule Definitions, Sandbox Definitions, and Agent Definitions use that model.

| Need | Read |
| --- | --- |
| Understand portable Definitions and location-derived discovery | [Definitions and discovery](/docs/concepts/definitions-and-discovery) |
| Check where Definition files belong | [File conventions](/docs/reference/file-conventions) |
| Inspect generated host artifacts | [Provider output](/docs/reference/provider-output) |
| Configure package integrations and host settings | [Config options](/docs/reference/config-options) |
| Use ViteHub's framework and host boundary | [Frameworks and hosts](/docs/frameworks-hosts) |
| Emit Cloudflare bindings, routes, queues, workflows, crons, and workers | [Cloudflare](/docs/frameworks-hosts/cloudflare) |
| Emit Vercel output for functions, queues, workflows, and runtime bindings | [Vercel](/docs/frameworks-hosts/vercel) |
| Run the generated server output yourself | [Node/self-hosted](/docs/frameworks-hosts/node-self-hosted) |

## Connect primitives to Agents

Capabilities expose controlled agent-facing access to primitives. A storage Capability can expose scoped read/edit tools, a Schedule Capability can manage allowed Runtime Schedules, and `workspaceShell()` can expose file inspection through Workspace and Shell boundaries.

Do not expose a primitive to a model just because the app uses it. Attach the relevant [Official Capability](/docs/capabilities/official-capabilities) only when the Agent needs that ability, then keep scopes, write modes, and approvals explicit.

| Need | Read |
| --- | --- |
| Build the Agent that will receive the ability | [Agents](/docs/agents) |
| Understand the agent-facing contribution model | [Capabilities overview](/docs/capabilities) |
| Pick from built-in Capability factories | [Official capabilities](/docs/capabilities/official-capabilities) |
| Expose KV with scoped storage tools | [KV capability](/docs/capabilities/kv) |
| Expose Blob storage with scoped file tools | [Blob capability](/docs/capabilities/blob) |
| Expose relational data intentionally | [Database capability](/docs/capabilities/db) |
| Let an Agent manage allowed Runtime Schedules | [Schedule capability](/docs/capabilities/schedule) |
| Expose Workspace-backed inspection or mutation | [Workspace shell](/docs/capabilities/workspace-shell) |
| Run isolated execution from an Agent boundary | [Sandbox capability](/docs/capabilities/sandbox) |

## Next steps

- [Build the first primitive](/docs/getting-started/first-server-primitive)
- [Build the first Agent](/docs/getting-started/first-agent)
- [Read the shared model](/docs/concepts/how-vitehub-fits-together)
