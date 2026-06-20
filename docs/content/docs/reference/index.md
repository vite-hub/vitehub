---
title: Package reference
description: Map ViteHub packages to their owned primitives, integrations, and public import surfaces.
navigation.title: Package reference
navigation.order: 50
icon: i-lucide-package
---

The package reference names ownership boundaries.
Each package owns the public APIs, Vite Integration, Provider Output, errors, and generated files for its primitive or runtime surface.

## Public packages

| Package | Owns | Primary imports |
| --- | --- | --- |
| `@vite-hub/vite` | Preset Vite Integration for the core ViteHub server primitives | `@vite-hub/vite` |
| `@vite-hub/agent` | Agent Definitions, Agent Invocations, Agent Driver boundary, Capability composition, Agent Evals, Agent Trigger API | `@vite-hub/agent`, `@vite-hub/agent/capabilities`, `@vite-hub/agent/channels`, `@vite-hub/agent/eval`, `@vite-hub/agent/vite` |
| `@vite-hub/auth` | Auth Definitions, Better Auth server wiring, generated Auth route behavior | `@vite-hub/auth`, `@vite-hub/auth/server`, `@vite-hub/auth/vite` |
| `@vite-hub/blob` | Blob Stores, Default Blob Store behavior, Blob Driver Modules, provider storage output | `@vite-hub/blob`, `@vite-hub/blob/vite`, `@vite-hub/blob/drivers/*` |
| `@vite-hub/database` | Database Definitions, Drizzle schema generation, D1 and hosted database wiring | `@vite-hub/database`, `@vite-hub/database/drizzle`, `@vite-hub/database/vite` |
| `@vite-hub/devtools` | ViteHub DevTools Client shell integration and DevTools Feature registration helpers | `@vite-hub/devtools` |
| `@vite-hub/env` | Env Declarations, Public Env, Server Env, Secret Env, generated env access | `@vite-hub/env`, `@vite-hub/env/vite`, `@vite-hub/env/server`, `@vite-hub/env/secret` |
| `@vite-hub/kv` | KV Runtime Helper and configured KV Stores | `@vite-hub/kv`, `@vite-hub/kv/vite` |
| `@vite-hub/queue` | Queue Definitions, queue dispatch Runtime Helpers, provider queue output | `@vite-hub/queue`, `@vite-hub/queue/vite` |
| `@vite-hub/runtime` | Runtime Host Context, Runtime Capability handles, Policy Decisions, approvals, Trace Events, leases | `@vite-hub/runtime` |
| `@vite-hub/sandbox` | Sandbox Definitions, Sandbox Runs, Sandbox Provider integration | `@vite-hub/sandbox`, `@vite-hub/sandbox/vite` |
| `@vite-hub/schedule` | Static schedules, runtime schedules, Schedule Targets, cron Provider Output | `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, `@vite-hub/schedule/vite` |
| `@vite-hub/shell` | Shell-shaped runtime execution providers and Workspace shell integration helpers | `@vite-hub/shell`, `@vite-hub/shell/workspace` |
| `@vite-hub/source` | Source Definitions and Source Loaders for file, glob, markdown, GitHub, custom, and MCP resource retrieval | `@vite-hub/source`, `@vite-hub/source/sources/*` |
| `@vite-hub/workflow` | Workflow Definitions, durable run state, step execution, provider workflow output | `@vite-hub/workflow`, `@vite-hub/workflow/vite` |
| `@vite-hub/workspace` | Workspace Definitions, Workspace Stores, Source Bindings, Workspace Runtime Surface, Workspace extensions | `@vite-hub/workspace`, `@vite-hub/workspace/vite`, `@vite-hub/workspace/runtime` |

## Internal and support packages

| Package | Status | Purpose |
| --- | --- | --- |
| `@vite-hub/cli` | Public CLI package | Loads Vite config and runs package-owned CLI namespaces. |
| `@vite-hub/ci` | Support package | Provides CI provider adapters and log extraction utilities. |
| `@vite-hub/internal` | Internal package | Shared discovery, Provider Output, provisioning, runtime, and build helpers. |

## Package rules

Public package imports should stay package-owned.
Application code should not import `@vite-hub/internal`, generated files, or framework virtual modules unless a package reference explicitly promotes the path.

Provider-specific behavior belongs to the package that owns the primitive.
For example, Blob Provider SDK Adapters belong behind Blob Driver Modules, and Workspace Provider Adapters stay behind Workspace configuration and generated runtime wiring.

## Related

- [Import paths](/docs/reference/import-paths)
- [Config options](/docs/reference/config-options)
- [Provider output](/docs/reference/provider-output)
