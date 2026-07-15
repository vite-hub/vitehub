---
title: Import paths
description: Distinguish stable ViteHub imports from generated files, provider modules, and internal package paths.
navigation.order: 51
icon: i-lucide-route
---

Stable ViteHub Import Paths are ViteHub-owned app-facing import specifiers.
They may resolve to Runtime Registries, generated files, virtual modules, or
owner-package runtime code, but application code should not depend on that
implementation detail.

## Canonical application imports

Applications that install `vite-hub` use the root only for framework
composition and explicit feature subpaths for application APIs.

| Import path | Use |
| --- | --- |
| `vite-hub` | Register the framework Vite Integration with `vitehub()`. |
| `vite-hub/agent` | Agent Definition, invocation, trigger, and Agent Actor APIs. |
| `vite-hub/agent/capabilities` | Official Capability factories. |
| `vite-hub/agent/channels` | Official Channel Kind helpers. |
| `vite-hub/auth` and `vite-hub/auth/server` | Auth Definitions and server runtime helpers. |
| `vite-hub/blob` | Blob Runtime Helpers and Blob Store access. |
| `vite-hub/box` | Box Definitions and trusted-host execution contracts. |
| `vite-hub/database` and `vite-hub/database/drizzle` | Database Definitions and generated Drizzle access. |
| `vite-hub/env` | Env Declaration helpers and authoring types. |
| `vite-hub/email`, `vite-hub/email/server`, and `vite-hub/email/markdown` | Email Definitions, runtime delivery, and Dynamic Markdown HTML with a composed Markdown text fallback. |
| `vite-hub/env/presets` and `vite-hub/env/schema` | Reusable Env presets and schema helpers. |
| `vite-hub/env/secret` and `vite-hub/env/server` | Secret declarations and server-only Env access. |
| `vite-hub/kv` | KV Runtime Helper. |
| `vite-hub/queue` | Queue Definitions and dispatch helpers. |
| `vite-hub/runtime` | Runtime Host Context, policy, approval, trace, and capability APIs. |
| `vite-hub/sandbox` | Sandbox Definitions and Sandbox Run helpers. |
| `vite-hub/schedule` and `vite-hub/schedule/runtime` | Static and runtime Schedule APIs. |
| `vite-hub/shell` | Shell runtime and command analysis APIs. |
| `vite-hub/shell/workspace` | Workspace-backed Shell execution helpers. |
| `vite-hub/source` | Source Definitions, loaders, and registry APIs. |
| `vite-hub/workflow` | Workflow Definitions and run helpers. |
| `vite-hub/workspace` and `vite-hub/workspace/runtime` | Workspace Definitions, Sources, runtime facades, and registry APIs. |

Third-party model providers, chat adapters, and harness packages remain explicit
dependencies. Workflow retains its Vercel Functions runtime default; other
provider-specific and host-specific ViteHub subpaths stay on their owner packages
unless this reference promotes them.

## Direct owner-package imports

Every owner package remains independently installable. These paths are stable
for libraries, focused integrations, and advanced composition.

| Import path | Owner | Use |
| --- | --- | --- |
| `@vite-hub/agent` | Agent Package | Agent Definition helpers, invocation helpers, trigger helpers, Agent Actor types, and legacy Agent Invoker compatibility types. |
| `@vite-hub/agent/capabilities` | Agent Package | Official Capability factories such as `access()`, `browser()`, `workspaceShell()`, `inputCommands()`, and `subagents()`. |
| `@vite-hub/agent/channels` | Agent Package | Official Channel Kind helpers such as `github()`, `teams()`, `telegram()`, `webChat()`, and `defineChannel()`. |
| `@vite-hub/agent/eval` | Agent Package | Agent Eval authoring helpers. |
| `@vite-hub/agent/test` | Agent Package | Agent test runner helpers for local and CI Agent Invocation checks. |
| `@vite-hub/agent/harness/codex` | Agent Package | Codex harness integration; install its third-party harness dependencies explicitly. |
| `@vite-hub/agent/harness/local-sandbox` | Agent Package | Trusted local harness sandbox helper for development and Agent Evals. |
| `@vite-hub/agent/cloudflare` | Agent Package | Cloudflare Agent state helpers. |
| `@vite-hub/auth` | Auth Package | Auth Definition helpers. |
| `@vite-hub/auth/server` | Auth Package | Better Auth runtime creation, request handlers, and session access for manual host integration. |
| `@vite-hub/blob` | Blob Package | Blob Runtime Helpers and Blob Store access. |
| `@vite-hub/email` | Email Package | Email Definition, explicit clients, portable types, and normalized errors. |
| `@vite-hub/email/server` | Email Runtime | Server-only discovered `email` Runtime Helper. |
| `@vite-hub/email/drivers/smtp` | Email Package | Optional Node.js SMTP delivery through Nodemailer. |
| `@vite-hub/email/markdown` | Email Package | Dynamic Markdown composition into HTML and a composed Markdown text fallback. |
| `@vite-hub/email/test` | Email Package | Isolated in-memory message capture for tests. |
| `@vite-hub/database/drizzle` | Database Package | Generated Drizzle `db` and `schema` access. |
| `@vite-hub/env` | Env Package | Env Declaration helpers. |
| `#vitehub/env/public` | Env Package | Generated Public Env access. |
| `#vitehub/env/server` | Env Package | Generated Server Env access. |
| `@vite-hub/kv` | KV Package | KV Runtime Helper. |
| `@vite-hub/queue` | Queue Package | Queue Definition and enqueue Runtime Helper. |
| `@vite-hub/sandbox` | Sandbox Package | Sandbox Definition and Sandbox Run helpers. |
| `@vite-hub/schedule/runtime` | Schedule Package | Runtime schedule helpers. |
| `@vite-hub/schedule/runtime/driver` | Schedule Package | Host integration boundary for reconciling stored Runtime Schedules with native wake registrations. |
| `#vitehub/schedule/registry` | Schedule Package | Generated static schedule registry for host bridges. |
| `@vite-hub/workflow` | Workflow Package | Workflow Definition and run helpers. |
| `@vite-hub/workflow/runtime/openworkflow-worker` | Workflow Package | OpenWorkflow-specific worker lifecycle helpers; install `openworkflow` explicitly. |
| `@vite-hub/workspace` | Workspace Package | Workspace Definition, Source helpers, Workspace facade access, and authoring types. |
| `@vite-hub/workspace/runtime` | Workspace Package | Workspace runtime registry, `useWorkspace()`, and source resolution/request helpers for integrations. |

## Integration imports

| Import path | Use |
| --- | --- |
| `vite-hub` | Canonical application import for `vitehub()`. |
| `@vite-hub/vite` | Supported root-only compatibility import for `vitehub()`. It has no feature subpaths. |
| `@vite-hub/agent/vite` | Register the Agent Vite Integration. |
| `@vite-hub/auth/vite` | Register the Auth Vite Integration. |
| `@vite-hub/blob/vite` | Register the Blob Vite Integration. |
| `@vite-hub/database/vite` | Register the Database Vite Integration. |
| `@vite-hub/email/vite` | Register singleton Email Definition discovery and runtime binding. |
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
| `vite-hub/_internal/*` | Internal | Generated ViteHub code only; application imports are unsupported. |
| `@vite-hub/internal/*` | Internal | Package implementation only. |

The Agent Package does not expose an `@vite-hub/agent/netlify` application import. Netlify Agent output is generated Provider Output under `.netlify/v1` plus the `.vitehub/agent/netlify-function.mjs` source wrapper.

The framework distribution does not introduce public `vite-hub/*/vite` or
provider-specific application aliases. Use root `vitehub()` for framework
composition and the owner-package paths above for advanced integration control.

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Migrate to `vite-hub`](/docs/getting-started/migration)
