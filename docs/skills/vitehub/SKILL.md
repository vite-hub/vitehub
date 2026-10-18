---
name: vitehub
description: Build and debug complete ViteHub apps from live docs and installed contracts. Use for server primitives and Runtime Helpers; Agent Definitions, Drivers, Capabilities, Workspaces, Sources, Channels, Triggers, or orchestration; Vite/Nuxt integration, Provider Output, previews, hosts, and deployment.
---

# ViteHub

Use one proof loop: orient, route, inspect the contract, build, and prove. Exact package exports, installed types, and current raw docs outrank remembered or project-example syntax.

## 1. Orient

- Inspect the package manifest, lockfile, Vite or Nuxt config, server entry, and nearby project instructions.
- Identify installed ViteHub packages and versions, package manager, framework, host target, and requested outcome.
- Open `https://vitehub.dev/llms.txt`, then select the smallest raw Markdown page covering the primary behavior. Links inside references are selection menus; do not open every linked page.

Orientation is complete when the current setup, target outcome, host boundary, and first docs URL are named.

## 2. Route before code

Choose one primary lane. Server Primitives serve application behavior through Vite Integrations and Runtime Helpers. Agents serve model-backed, provider-backed, or custom-run behavior through Agent Definitions; they may compose Server Primitives without changing the primary lane.

Read only the references whose conditions match, but read them before writing code:

| Task condition | Required reference |
| --- | --- |
| New project, uncertain file layout, or cross-feature composition | [Project shapes](references/project-shapes.md) |
| Released or `pkg.pr.new` installation, upgrade, or package mismatch | [Installed and preview contracts](references/preview-contract.md) |
| Choosing between Server Primitives | [Server Primitives](references/server-primitives.md) |
| Auth, sessions, or route protection | [Auth](references/primitives/auth.md) |
| Blob uploads or object storage | [Blob](references/primitives/blob.md) |
| Browser sessions or remote browser actions | [Browser](references/primitives/browser.md) |
| Outbound application message delivery | [Channels](references/primitives/channels.md) |
| OAuth or provider account access | [Connections](references/primitives/connections.md) |
| Comark content, Markdown, or content queries | [Content](references/primitives/content.md) |
| Relational data or Drizzle | [Database](references/primitives/database.md) |
| Email or Markdown email templates | [Email](references/primitives/email.md) |
| Public, server, secret, or provider-backed values | [Env](references/primitives/env.md) |
| KV values, flags, cursors, or short-lived state | [KV](references/primitives/kv.md) |
| Queue jobs and consumers | [Queue](references/primitives/queue.md) |
| Atomic request budgets | [Rate Limit](references/primitives/rate-limit.md) |
| Realtime collaboration | [Realtime](references/primitives/realtime.md) |
| Isolated provider-backed task runs | [Sandbox Tasks](references/primitives/sandbox-task.md) |
| Static cron schedules | [Schedule](references/primitives/schedule.md) |
| Bounded shell commands | [Shell](references/primitives/shell.md) |
| Read-only external files or resources | [Source](references/primitives/source.md) |
| Durable long-running orchestration | [Workflow](references/primitives/workflow.md) |
| Persistent files, Sources, snapshots, or write-back | [Workspace](references/primitives/workspace.md) |
| Trusted-host or provider execution sessions | [Sandboxes](references/primitives/sandbox.md) |
| Nitro cache storage | [Cache](references/primitives/cache.md) |
| Markdown rendering with bindings | [Markdown Templates](references/primitives/markdown-template.md) |
| Modify an existing framework integration; add Nitro or Nuxt; use generated types; configure a provider; or diagnose a framework-specific failure | [Framework composition](references/framework-composition.md) |
| Agent Definition, Agent Driver, Agent Invocation, instructions, output, hooks, or Evals | [Agent Definitions and Drivers](references/agent-definitions.md) |
| Workspace, Source, access scope, mounted files, or write-back | [Workspaces, Sources, and access](references/workspaces-sources-access.md) |
| Agent Channel, Trigger, webhook admission, concurrency, or Agent delivery | [Channels and Triggers](references/channels-triggers.md) |
| Capability, tool, secret, rate limit, telemetry, or other granted authority | [Capabilities and authority](references/capabilities-authority.md) |
| Schedule, Workflow, orchestration retry, idempotency, or terminal state | [Schedules, Workflows, and Invocations](references/schedules-workflows-invocations.md) |
| Sandbox, trusted host, isolation, required command, or deployment target | [Sandboxes and hosts](references/sandboxes-hosts.md) |
| A proof has failed, generated state disagrees, or a runtime/host failure needs diagnosis | [Proof and recovery](references/proof-recovery.md) |
| Looking for a complete public application pattern | [Project patterns](references/project-patterns.md) |

Routing is complete when every requested behavior has one primary lane and every matching reference has been read. Start with the smallest matching set, then add a cross-cutting reference when the task spans lanes.

## 3. Inspect the installed contract

- Read each installed package's `package.json`, exports, relevant types, and generated declarations before writing imports or options.
- For a fresh application, install `vite-hub` and use its root integration plus feature subpaths. Use direct owner packages only for a focused library, an unexported advanced subpath, or an installed older contract.
- When docs, examples, and installed artifacts disagree, implement the installed artifacts and record the mismatch. Treat project examples as patterns whose imports must be revalidated.

Contract inspection is complete when every planned package, import, option, generated path, and runtime entry exists in the installed graph; no syntax is inferred only from memory.

## 4. Build the coherent file set

Before editing, map every requested behavior to:

| Behavior | Package owner | Source file | Runtime path | Authority or persistence | Proof |
| --- | --- | --- | --- | --- | --- |

Then implement the smallest coherent set: manifest and lockfile, framework integration, discovered Definition where needed, application or orchestration entrypoint, and proof surface. Keep application authority in application code; grant an Agent access only through visible Capabilities, Workspace rules, Sources, or Channels.

Building is complete when every requested behavior has an implemented row and no placeholder, unused integration, implicit authority, or unowned persistence remains.

## 5. Prove and repair

- Run the narrow typecheck or package test nearest the change, then the relevant build.
- Prove the actual lane: execute the Runtime Helper, perform an Agent Invocation, exercise the webhook or schedule, or inspect generated Provider Output.
- On failure, return to installed exports/types, `.vitehub` generated state, the selected raw docs page, and [Proof and recovery](references/proof-recovery.md). Repair the cause and rerun the same proof.

The task is complete when every behavior row has an observed result, or a precise source-backed unsupported boundary. Report commands and observations, docs URLs, installed ViteHub versions or preview commit, contract mismatches, and host limitations.
