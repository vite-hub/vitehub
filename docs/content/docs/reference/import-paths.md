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
| `@vite-hub/agent` | Agent Package | Agent Definition helpers, invocation helpers, trigger helpers, Agent Invoker types. |
| `@vite-hub/agent/capabilities` | Agent Package | Official Capability factories such as `chat()`, `access()`, `workspaceShell()`, and `inputCommands()`. |
| `@vite-hub/agent/eval` | Agent Package | Agent Eval authoring helpers. |
| `@vite-hub/auth` | Auth Package | Auth Definition helpers. |
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
| `@vite-hub/workspace` | Workspace Package | Workspace Definition, Source helpers, and Workspace Runtime Surface. |

## Integration imports

| Import path | Use |
| --- | --- |
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
| `dist/**/wrangler.json` | Generated Provider Output | Deploy or inspect as Cloudflare output. |
| Vite virtual module ids with `\0` prefixes | Internal | Never import directly. |
| `@vite-hub/internal/*` | Internal | Package implementation only. |

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
