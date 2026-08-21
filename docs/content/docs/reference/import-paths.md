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
| `vite-hub/agent/eval` | Agent Eval authoring helpers; install Evalite and the test runner explicitly. |
| `vite-hub/agent/harness/local-sandbox` | Trusted local harness sandbox helper for development and Agent Evals. |
| `vite-hub/agent/cloudflare` | Cloudflare Agent state configuration helpers. |
| `vite-hub/agent/vue` | Vue Agent client handle and AI SDK chat composable. |
| `vite-hub/agent/server` and `vite-hub/agent/state/sqlite` | Manual server integration and libSQL-compatible durable Agent state. |
| `vite-hub/agent/invocations/sqlite` | LibSQL-compatible durable Agent Invocation Journal. |
| `vite-hub/auth` and `vite-hub/auth/server` | Auth Definitions and server runtime helpers. |
| `vite-hub/auth/agent` | Better Auth session mapping into Agent Invokers. |
| `vite-hub/auth/vue` | Better Auth Vue client and normalized session composables. |
| `vite-hub/blob` | Blob Runtime Helpers and Blob Store access. |
| `vite-hub/blob/content-type` | Detect common image and PDF signatures from leading bytes before upload. |
| `vite-hub/browser` | Browser Definitions, invocation-scoped Playwright sessions, and named Browser runs. |
| `vite-hub/browser/actions` | ViteHub Browser actions backed by Cloudflare Browser Run. |
| `vite-hub/browser/controllers/cdp` and `vite-hub/browser/controllers/playwright` | Advanced raw CDP and Playwright Browser Session controllers. |
| `vite-hub/browser/providers/cloudflare` and `vite-hub/browser/providers/local` | Advanced explicit provider selection for low-level Browser Clients. |
| `vite-hub/channels` and `vite-hub/channels/server` | Channel Definitions and discovered named delivery. |
| `vite-hub/box` | Box Definitions and built-in runtime selection for trusted-host, Crabbox, ASCII, Cloudflare Sandbox, Cloudflare Computer, and Vercel Sandbox execution. |
| `vite-hub/database` and `vite-hub/database/drizzle` | Database Definitions and generated Drizzle access. |
| `vite-hub/env` | Env Declaration helpers and authoring types. |
| `vite-hub/email`, `vite-hub/email/server`, and `vite-hub/email/markdown` | Email clients, configured runtime delivery, and Dynamic Markdown HTML with a composed Markdown text fallback. |
| `vite-hub/env/presets` and `vite-hub/env/schema` | Reusable Env presets and schema helpers. |
| `vite-hub/env/secret` and `vite-hub/env/server` | Secret declarations and server-only Env access. |
| `vite-hub/history` | Durable Workspace history checkpoint contract and types. |
| `vite-hub/kv` | KV Runtime Helper. |
| `vite-hub/markdown-template` | Deterministic Markdown rendering from explicit template strings. |
| `vite-hub/queue` | Queue Definitions and dispatch helpers. |
| `vite-hub/rate-limit` | Source-local managed Rate Limit handles and direct Rate Limiters. |
| `vite-hub/realtime`, `vite-hub/realtime/server`, and `vite-hub/realtime/vue` | Realtime Definitions, manual server integration, and Vue collaborative editing with canonical [Realtime checkpoints](/docs/reference/realtime). |
| `vite-hub/runtime` | Runtime Host Context, policy, approval, trace, and capability APIs. |
| `vite-hub/sandbox` | Sandbox Definitions and Sandbox Run helpers. |
| `vite-hub/schedule` and `vite-hub/schedule/runtime` | Static and runtime Schedule APIs. |
| `vite-hub/schedule/runtime/driver` and `vite-hub/schedule/runtime/process` | Host wake registration and process-backed runtime Schedule controls. |
| `vite-hub/shell` | Shell runtime and command analysis APIs. |
| `vite-hub/shell/providers/cloudflare` and `vite-hub/shell/providers/just-bash` | Cloudflare and Just Bash Shell providers. |
| `vite-hub/shell/workspace` | Workspace-backed Shell execution helpers. |
| `vite-hub/source` | Runtime-neutral Source Definitions, custom loaders, and registry APIs. |
| `vite-hub/source/file`, `vite-hub/source/glob`, and `vite-hub/source/markdown` | Local file implementations, loaded only when selected. |
| `vite-hub/source/github` | GitHub Source implementation, loaded only when selected. |
| `vite-hub/source/mcp` | MCP Resources implementation with its private SDK closure. |
| `vite-hub/tsconfig` | TypeScript config that includes ViteHub's generated declaration entry without taking ownership of application source includes. |
| `vite-hub/workflow` | Workflow Definitions and run helpers. |
| `vite-hub/workspace` and `vite-hub/workspace/runtime` | Workspace Definitions, Sources, runtime facades, and registry APIs. |
| `vite-hub/workspace/cloudflare` | Cloudflare Workspace runtime setup. |
| `vite-hub/workspace/collections` and `vite-hub/workspace/collections/client` | Bounded Workspace Collection queries and optional Vue client composables. |
| `vite-hub/workspace/loader`, `vite-hub/workspace/publish`, and `vite-hub/workspace/server` | Workspace loader, publisher, and manual server extension APIs. |

ViteHub-owned adapters use canonical `vite-hub/*` imports. Their optional
third-party providers and SDKs remain explicit dependencies. Provider Output,
build integrations, tests, and unlisted provider-specific modules stay on their
owner packages.

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
| `@vite-hub/agent/harness/local-sandbox` | Agent Package | Trusted local harness sandbox helper for development and Agent Evals. |
| `@vite-hub/agent/cloudflare` | Agent Package | Cloudflare Agent state helpers. |
| `@vite-hub/agent/vue` | Agent Package | Vue Agent client handle and AI SDK chat composable. |
| `@vite-hub/auth` | Auth Package | Auth Definition helpers. |
| `@vite-hub/auth/server` | Auth Package | Better Auth runtime creation, request handlers, and session access for manual host integration. |
| `@vite-hub/blob` | Blob Package | Blob Runtime Helpers and Blob Store access. |
| `@vite-hub/blob/content-type` | Blob Package | Detect common image and PDF signatures from leading bytes before upload. |
| `@vite-hub/browser` | Browser Package | Browser Definitions, invocation-scoped sessions, and low-level Browser Client lifecycle. |
| `@vite-hub/browser/actions` | Browser Package | ViteHub Browser actions backed by Cloudflare Browser Run. |
| `@vite-hub/browser/controllers/cdp` and `@vite-hub/browser/controllers/playwright` | Browser Package | Raw CDP and Playwright Browser Session controllers. |
| `@vite-hub/browser/providers/cloudflare` and `@vite-hub/browser/providers/local` | Browser Package | Cloudflare Browser Run and local Chromium providers. |
| `@vite-hub/box` | Box Package | Box Definitions, sessions, and built-in runtime selection. |
| `@vite-hub/channels` | Channels Package | Channel Definitions, explicit clients, portable types, and normalized delivery results. |
| `@vite-hub/channels/server` | Channels Runtime | Server-only discovered named delivery. |
| `@vite-hub/email` | Email Package | Explicit clients, portable types, and normalized errors. |
| `@vite-hub/email/server` | Email Runtime | Server-only configured `email` Runtime Helper. |
| `@vite-hub/email/markdown` | Email Package | Dynamic Markdown composition into HTML and a composed Markdown text fallback. |
| `@vite-hub/email/test` | Email Package | Isolated in-memory message capture for tests. |
| `@vite-hub/database/drizzle` | Database Package | Generated Drizzle `db` and `schema` access. |
| `@vite-hub/env` | Env Package | Env Declaration helpers. |
| `@vite-hub/history` | History Package | Durable history checkpoint contract and types. |
| `#vitehub/env/public` | Env Package | Generated Public Env access. |
| `#vitehub/env/server` | Env Package | Generated Server Env access. |
| `@vite-hub/kv` | KV Package | KV Runtime Helper. |
| `@vite-hub/markdown-template` | Markdown Template Package | Deterministic Markdown rendering from explicit template strings. |
| `#vitehub/templates` | Markdown Template Package | Generated named-template renderer and `TemplateName` union for `server/templates/**/*.md`. |
| `@vite-hub/queue` | Queue Package | Queue Definition and enqueue Runtime Helper. |
| `@vite-hub/rate-limit` | Rate Limit Package | Source-local managed Rate Limit handles and direct Rate Limiters. |
| `@vite-hub/rate-limit/drivers/memory` | Rate Limit Package | Local, test, and single-process fixed-window enforcement. |
| `@vite-hub/rate-limit/drivers/cloudflare` | Rate Limit Package | Direct access to a Cloudflare Rate Limiting binding. |
| `@vite-hub/realtime` | Realtime Package | Realtime Definitions and portable collaboration types. |
| `@vite-hub/realtime/server` and `@vite-hub/realtime/vue` | Realtime Package | Manual server integration and Vue collaborative editing. |
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
| `vite-hub/nuxt` | Register the framework Nuxt module and carry Vite integration configuration into Nitro. |
| `@vite-hub/agent/vite` | Register the Agent Vite Integration. |
| `@vite-hub/auth/vite` | Register the Auth Vite Integration. |
| `@vite-hub/blob/vite` | Register the Blob Vite Integration. |
| `@vite-hub/browser/vite` | Register Cloudflare Browser Run Provider Output. |
| `@vite-hub/channels/vite` | Register Channel Definition discovery and generated runtime bindings. |
| `@vite-hub/database/vite` | Register the Database Vite Integration. |
| `@vite-hub/email/vite` | Configure one Unemail provider and generate its runtime binding. |
| `@vite-hub/env/vite` | Register the Env Vite Integration and `env()` declaration helper. |
| `@vite-hub/kv/vite` | Register the KV Vite Integration. |
| `@vite-hub/markdown-template/vite` | Register Markdown template discovery, generated types, and direct `.template.md` imports. |
| `@vite-hub/queue/vite` | Register the Queue Vite Integration. |
| `@vite-hub/rate-limit/vite` | Register Rate Limit source collection and provider output. |
| `@vite-hub/realtime/vite` | Register Realtime Definition discovery and generated runtime wiring. |
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
With Nuxt, that source wrapper is generated under `<buildDir>/vitehub/agent/netlify-function.mjs` (normally `.nuxt/vitehub/agent/netlify-function.mjs`).

The framework distribution does not introduce public `vite-hub/*/vite` or
provider-specific application aliases. Use root `vitehub()` for framework
composition and the owner-package paths above for advanced integration control.

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
- [Migrate to `vite-hub`](/docs/getting-started/migration)
