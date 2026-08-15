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
| KV, Blob, Database, Env, Email, Queue, Rate Limit, Sandbox, Shell, or another Server Primitive | [Server Primitives](references/server-primitives.md) |
| Modify an existing framework integration; add Nitro or Nuxt; use generated types; configure a provider; or diagnose a framework-specific failure | [Framework composition](references/framework-composition.md) |
| Agent Definition, Agent Driver, Agent Invocation, instructions, output, hooks, or Evals | [Agent Definitions and Drivers](references/agent-definitions.md) |
| Workspace, Source, access scope, mounted files, or write-back | [Workspaces, Sources, and access](references/workspaces-sources-access.md) |
| Channel, Trigger, webhook, messages, admission, concurrency, or delivery | [Channels and Triggers](references/channels-triggers.md) |
| Capability, tool, secret, rate limit, telemetry, or other granted authority | [Capabilities and authority](references/capabilities-authority.md) |
| Schedule, Workflow, orchestration retry, idempotency, or terminal state | [Schedules, Workflows, and Invocations](references/schedules-workflows-invocations.md) |
| Box, trusted host, isolation, required command, or deployment target | [Boxes and hosts](references/boxes-hosts.md) |
| A proof has failed, generated state disagrees, or a runtime/host failure needs diagnosis | [Proof and recovery](references/proof-recovery.md) |
| Looking for a complete public application pattern | [Project patterns](references/project-patterns.md) |
| Existing `@vitehub/*`, `@vite-hub/vite`, or individual `hubX()` composition | [Migration quarantine](references/migration.md) |

Routing is complete when every requested behavior has one primary lane and every matching reference has been read. Do not load the whole library.

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
