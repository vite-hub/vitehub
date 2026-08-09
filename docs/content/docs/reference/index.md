---
title: Package reference
description: Map the ViteHub framework distribution and independent owner packages to their public surfaces.
navigation.title: Package reference
navigation.order: 50
icon: i-lucide-package
---

The framework distribution is the canonical application dependency. Independent
owner packages preserve package-level composition for libraries and advanced
integrations.

## Framework distribution

| Package | Owns | Primary imports |
| --- | --- | --- |
| `vite-hub` | Framework defaults, the `vitehub()` Vite Integration, the tested compatibility matrix, and intentional feature subpaths | `vite-hub`, `vite-hub/agent`, `vite-hub/env`, `vite-hub/workspace`, `vite-hub/workflow` |

The root export stays focused on framework composition. Runtime Helpers,
Definitions, Capabilities, and other application APIs use feature subpaths
instead of one root barrel.

## Independent owner packages

| Package | Owns | Primary imports |
| --- | --- | --- |
| `@vite-hub/agent` | Agent Definitions, Agent Invocations, Agent Driver boundary, Capability composition, Agent Evals, Agent Trigger API | `@vite-hub/agent`, `@vite-hub/agent/capabilities`, `@vite-hub/agent/channels`, `@vite-hub/agent/eval`, `@vite-hub/agent/vite` |
| `@vite-hub/auth` | Auth Definitions, Better Auth server wiring, generated Auth route behavior | `@vite-hub/auth`, `@vite-hub/auth/server`, `@vite-hub/auth/vite` |
| `@vite-hub/blob` | Blob Stores, Default Blob Store behavior, Blob Driver Modules, provider storage output | `@vite-hub/blob`, `@vite-hub/blob/vite`, `@vite-hub/blob/drivers/*` |
| `@vite-hub/browser` | Browser Definitions, invocation-scoped sessions, low-level controllers and providers, live handoff, and Browser Run output | `@vite-hub/browser`, `@vite-hub/browser/controllers/*`, `@vite-hub/browser/providers/*`, `@vite-hub/browser/vite` |
| `@vite-hub/box` | Box Definitions and provider-neutral execution sessions | `@vite-hub/box` |
| `@vite-hub/database` | Database Definitions, Drizzle schema generation, D1 and hosted database wiring | `@vite-hub/database`, `@vite-hub/database/drizzle`, `@vite-hub/database/vite` |
| `@vite-hub/email` | Declarative Unemail provider integration, runtime delivery, Dynamic Markdown composition, and test capture | `@vite-hub/email`, `@vite-hub/email/markdown`, `@vite-hub/email/server`, `@vite-hub/email/test`, `@vite-hub/email/vite` |
| `@vite-hub/env` | Env Declarations, Public Env, Server Env, Secret Env, generated env access | `@vite-hub/env`, `@vite-hub/env/vite`, `@vite-hub/env/server`, `@vite-hub/env/secret` |
| `@vite-hub/kv` | KV Runtime Helper and configured KV Stores | `@vite-hub/kv`, `@vite-hub/kv/vite` |
| `@vite-hub/queue` | Queue Definitions, queue dispatch Runtime Helpers, provider queue output | `@vite-hub/queue`, `@vite-hub/queue/vite` |
| `@vite-hub/runtime` | Runtime Host Context, Runtime Capability handles, Policy Decisions, approvals, Trace Events, leases | `@vite-hub/runtime` |
| `@vite-hub/sandbox` | Sandbox Definitions, Sandbox Runs, Sandbox Provider integration | `@vite-hub/sandbox`, `@vite-hub/sandbox/vite` |
| `@vite-hub/schedule` | Static schedules, runtime schedules, Schedule Targets, cron Provider Output | `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, `@vite-hub/schedule/vite` |
| `@vite-hub/shell` | Shell-shaped runtime execution providers and Workspace shell integration helpers | `@vite-hub/shell`, `@vite-hub/shell/workspace` |
| `@vite-hub/source` | Source Definitions and Source Loaders for file, glob, markdown, GitHub, custom, and MCP resource retrieval | `@vite-hub/source` |
| `@vite-hub/workflow` | Workflow Definitions, durable run state, step execution, provider workflow output | `@vite-hub/workflow`, `@vite-hub/workflow/vite` |
| `@vite-hub/workspace` | Workspace Definitions, Workspace Stores, Source Bindings, Workspace runtime facades, Workspace extensions | `@vite-hub/workspace`, `@vite-hub/workspace/vite`, `@vite-hub/workspace/runtime` |

## Internal and support packages

| Package | Status | Purpose |
| --- | --- | --- |
| `@vite-hub/cli` | Public CLI package | Loads Vite config and runs package-owned CLI namespaces. |
| `@vite-hub/internal` | Internal package | Shared discovery, Provider Output, provisioning, runtime, and build helpers. |

## Package rules

Applications should start with `vite-hub` and its documented feature subpaths.
Libraries and focused integrations may depend directly on the package that
owns the primitive.
Application code should not import `@vite-hub/internal`, generated files, or framework virtual modules unless a package reference explicitly promotes the path.

Provider-specific behavior belongs to the package that owns the primitive.
For example, Blob Provider SDK Adapters belong behind Blob Driver Modules, and Workspace Provider Adapters stay behind Workspace configuration and generated runtime wiring.

## Related

- [Import paths](/docs/reference/import-paths)
- [Config options](/docs/reference/config-options)
- [Provider output](/docs/reference/provider-output)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Migrate to `vite-hub`](/docs/getting-started/migration)
