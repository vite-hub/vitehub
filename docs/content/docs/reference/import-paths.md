---
title: Import paths
description: Distinguish stable ViteHub imports from generated files, provider modules, and internal package paths.
navigation.order: 51
icon: i-lucide-route
---

Stable ViteHub Import Paths are ViteHub-owned app-facing import specifiers.
They may resolve to Runtime Registries, generated files, virtual modules, or package runtime code, but application code should not depend on that implementation detail.

## Stable app imports

| Import path | Owner | Use |
| --- | --- | --- |
| `@vite-hub/agent` | Agent Package | Agent Definition helpers, invocation helpers, trigger helpers, Agent Actor types, and legacy Agent Invoker compatibility types. |
| `@vite-hub/agent/capabilities` | Agent Package | Official Capability factories such as `access()`, `browser()`, `workspaceShell()`, `inputCommands()`, and `subagents()`. |
| `@vite-hub/agent/channels` | Agent Package | Official Channel Kind helpers such as `github()`, `stream()`, `teams()`, `telegram()`, `webChat()`, and `defineChannel()`. |
| `@vite-hub/agent/eval` | Agent Package | Agent Eval authoring helpers. |
| `@vite-hub/agent/test` | Agent Package | Agent test runner helpers for local and CI Agent Invocation checks. |
| `@vite-hub/agent/harness/local-sandbox` | Agent Package | Trusted local harness sandbox helper for development and Agent Evals. |
| `@vite-hub/agent/cloudflare` | Agent Package | Cloudflare Agent state helpers. |
| `@vite-hub/auth` | Auth Package | Auth Definition helpers. |
| `@vite-hub/auth/server` | Auth Package | Better Auth runtime creation, request handlers, and session access for manual host integration. |
| `@vite-hub/blob` | Blob Package | Blob Runtime Helpers and Blob Store access. |
| `@vite-hub/database/drizzle` | Database Package | Generated Drizzle `db` and `schema` access. |
| `@vite-hub/env` | Env Package | Env Declaration helpers. |
| `#vitehub/env/public` | Env Package | Generated Public Env access. |
| `#vitehub/env/server` | Env Package | Generated Server Env access. |
| `@vite-hub/kv` | KV Package | KV Runtime Helper. |
| `@vite-hub/queue` | Queue Package | Queue Definition and enqueue Runtime Helper. |
| `@vite-hub/sandbox` | Sandbox Package | Sandbox Definition and Sandbox Run helpers. |
| `@vite-hub/schedule/runtime` | Schedule Package | Runtime schedule helpers. |
| `#vitehub/schedule/registry` | Schedule Package | Generated static schedule registry for host bridges. |
| `@vite-hub/workflow` | Workflow Package | Workflow Definition and run helpers. |
| `@vite-hub/workspace` | Workspace Package | Workspace Definition, Source helpers, Workspace facade access, and authoring types. |
| `@vite-hub/workspace/runtime` | Workspace Package | Workspace runtime registry, `useWorkspace()`, and source resolution/request helpers for integrations. |

## Integration imports

| Import path | Use |
| --- | --- |
| `@vite-hub/vite` | Register the preset Vite Integration with `vitehub()`. It composes package-owned integrations but does not re-export their application APIs. |
| `@vite-hub/agent/vite` | Register the Agent Vite Integration. |
| `@vite-hub/auth/vite` | Register the Auth Vite Integration. |
| `@vite-hub/blob/vite` | Register the Blob Vite Integration. |
| `@vite-hub/database/vite` | Register the Database Vite Integration. |
| `@vite-hub/env/vite` | Register the Env Vite Integration and `env()` declaration helper. |
| `@vite-hub/kv/vite` | Register the KV Vite Integration. |
| `@vite-hub/queue/vite` | Register the Queue Vite Integration. |
| `@vite-hub/sandbox/vite` | Register the Sandbox Vite Integration. |
| `@vite-hub/schedule/vite` | Register the Schedule Vite Integration. |
| `@vite-hub/workflow/vite` | Register the Workflow Vite Integration. |
| `@vite-hub/workspace/vite` | Register the Workspace Vite Integration. |

## Generated and internal paths

| Path family | Status | Guidance |
| --- | --- | --- |
| `.vitehub/**` | Generated | Inspect during development; do not author imports against these files. |
| `.vercel/output/**` | Generated Provider Output | Deploy or inspect as Vercel Build Output. |
| `.netlify/v1/**` | Generated Provider Output | Deploy or inspect as Netlify function output. |
| `dist/**/wrangler.json` | Generated Provider Output | Deploy or inspect as Cloudflare output. |
| Vite virtual module ids with `\0` prefixes | Internal | Never import directly. |
| `@vite-hub/internal/*` | Internal | Package implementation only. |

The Agent Package does not expose an `@vite-hub/agent/netlify` application import. Netlify Agent output is generated Provider Output under `.netlify/v1` plus the `.vitehub/agent/netlify-function.mjs` source wrapper.

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
