---
title: Server primitives
description: Add storage, queues, schedules, email, and other server APIs to a Vite app on any supported host.
navigation.title: Overview
navigation.order: 1
icon: i-lucide-server-cog
---

## Server primitives for Vite apps and any host

ViteHub adds storage, queues, schedules, email, and other server APIs to Vite apps. Call them from routes, handlers, jobs, or workers. You don't need an Agent Definition.

Start with [Your first server primitive](/docs/getting-started/first-server-primitive) for a runnable example. Return to Concepts when you need to understand generated imports or host configuration. Read the Agents section only when a model needs access to one of these APIs.

::u-page-grid{class="not-prose mt-8"}
  :::u-page-card
  ---
  title: First primitive
  description: Add KV to an app, register the Vite Integration, and call the Runtime Helper from server code.
  icon: i-lucide-rocket
  to: /docs/getting-started/first-server-primitive
  ---
  :::
  :::u-page-card
  ---
  title: Server model
  description: Learn how generated imports and host configuration keep application code independent from providers.
  icon: i-lucide-map
  to: /docs/concepts/server-primitives-for-any-host
  ---
  :::
  :::u-page-card
  ---
  title: Runtime imports
  description: Call primitives through ViteHub-owned imports instead of generated files or provider SDK wiring.
  icon: i-lucide-code-2
  to: /docs/concepts/runtime-helpers-and-stable-imports
  ---
  :::
  :::u-page-card
  ---
  title: Agents
  description: Give an Agent selected access to server APIs through Capabilities.
  icon: i-lucide-bot
  to: /docs/agents
  ---
  :::
::

:::note
Server code calls runtime helpers directly. Agents receive only the abilities added through Capabilities. Read [Runtime helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) and [Capabilities API](/docs/concepts/capabilities-api) when you need those contracts.
:::

## Pick the right primitive

| You need | Start with |
| --- | --- |
| Public, server, build-time, runtime, or secret environment values | [Env](/docs/server-primitives/env) |
| Application users, sessions, Better Auth routing, or guarded app routes | [Auth](/docs/server-primitives/auth) |
| Request budgets that must be consumed before expensive server work starts | [Rate Limit](/docs/server-primitives/rate-limit) |
| Outbound transactional messages with provider-neutral delivery | [Email](/docs/server-primitives/email) |
| Small key-addressed values, settings, flags, cursors, or lightweight state | [KV](/docs/server-primitives/kv) |
| Relational data, constraints, joins, migrations, or queryable history | [Database](/docs/server-primitives/database) |
| Uploads, generated artifacts, binary files, or object metadata | [Blob](/docs/server-primitives/blob) |
| Provider-backed browser sessions, screenshots, DOM inspection, or live handoff | [Browser](/docs/server-primitives/browser) |
| Persistent file-tree state, snapshots, diffs, rules, or sessions | [Workspace](/docs/server-primitives/workspace) |
| Collaborative Markdown editing, presence, and Workspace checkpoints | [Realtime](/docs/reference/realtime) |
| Read-only retrieval from files, globs, GitHub, markdown, MCP, or custom loaders | [Source](/docs/server-primitives/source) |
| Background delivery that returns before work finishes | [Queue](/docs/server-primitives/queue) |
| Durable long-running work with provider-tracked run state | [Workflows](/docs/server-primitives/workflows) |
| Static cron output or recurring runtime schedules | [Schedule](/docs/server-primitives/schedule) |
| Isolated provider-managed execution | [Sandbox](/docs/server-primitives/sandbox) |
| Controlled Unix-like command sessions | [Shell](/docs/server-primitives/shell) |

## Use primitives from server code

Most primitives expose the same application import on every host. ViteHub connects that import to the selected provider during the build.

```ts [server/api/settings.put.ts]
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

The route doesn't need to know whether KV uses local files, Cloudflare, Vercel, or another driver.

## Definitions and generated output

Some primitives work directly after configuration. Env, KV, Blob, Source, and Shell can often be called from server code without a discovered Definition.

Other primitives need a Definition so ViteHub can discover runtime behavior or named work. Email composes one declaratively configured provider, while Auth uses a singleton Definition bound at runtime. Database schemas, Workspace Definitions, Queue Definitions, Workflow Definitions, Static Schedule Definitions, Sandbox Definitions, and Agent Definitions can also generate Runtime Registries or host-specific Provider Output. Rate Limit uses source-local handles with explicit stable IDs instead of location-derived Definitions.

| Need | Read |
| --- | --- |
| Understand portable Definitions and location-derived discovery | [Definitions and discovery](/docs/concepts/definitions-and-discovery) |
| Check where Definition files belong | [File conventions](/docs/reference/file-conventions) |
| Inspect generated host artifacts | [Provider output](/docs/reference/provider-output) |
| Configure package integrations and host settings | [Config options](/docs/reference/config-options) |
| Use ViteHub's framework and host boundary | [Frameworks and hosts](/docs/frameworks-hosts) |
| Emit Cloudflare bindings, routes, queues, workflows, crons, and workers | [Cloudflare](/docs/frameworks-hosts/cloudflare) |
| Emit Vercel output for functions, queues, workflows, and runtime bindings | [Vercel](/docs/frameworks-hosts/vercel) |
| Emit Deno Agent server output and Deno cron wake output | [Deno](/docs/frameworks-hosts/deno) |
| Run the generated server output yourself | [Node/self-hosted](/docs/frameworks-hosts/node-self-hosted) |

## Connect primitives to Agents

Capabilities expose controlled agent-facing access to primitives. A storage Capability can expose scoped read/edit tools, a Schedule Capability can manage allowed Runtime Schedules, and `workspaceShell()` can expose file inspection through Workspace and Shell boundaries.

Don't expose a server API to a model just because the app uses it. Add the relevant [Official Capability](/docs/capabilities/official-capabilities) only when the Agent needs that ability. Configure its scope, write mode, and approvals for that task.

| Need | Read |
| --- | --- |
| Build the Agent that will receive the ability | [Agents](/docs/agents) |
| Understand the agent-facing contribution model | [Capabilities overview](/docs/capabilities) |
| Pick from built-in Capability factories | [Official capabilities](/docs/capabilities/official-capabilities) |
| Expose KV with scoped storage tools | [KV capability](/docs/capabilities/kv) |
| Expose Blob storage with scoped file tools | [Blob capability](/docs/capabilities/blob) |
| Expose relational data intentionally | [Database capability](/docs/capabilities/db) |
| Let an Agent send authorized plain-text email | [Email capability](/docs/capabilities/email) |
| Consume a trusted budget before an Agent Invocation | [Rate Limit capability](/docs/capabilities/rate-limit) |
| Give an Agent headless browser evidence through an allowlisted command | [Browser capability](/docs/capabilities/browser) |
| Let an Agent manage allowed Runtime Schedules | [Schedule capability](/docs/capabilities/schedule) |
| Expose Workspace-backed inspection or mutation | [Workspace shell](/docs/capabilities/workspace-shell) |
| Run isolated execution from an Agent boundary | [Sandbox capability](/docs/capabilities/sandbox) |

## Next steps

- [Build the first primitive](/docs/getting-started/first-server-primitive)
- [Build the first Agent](/docs/getting-started/first-agent)
- [Read the shared primitive pattern](/docs/concepts/server-primitives-for-any-host)
