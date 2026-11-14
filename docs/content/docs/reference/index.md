---
title: Package reference
description: Find the ViteHub package and public import path for each Server Primitive and feature.
navigation.title: Package reference
navigation.order: 50
navigation.group: Setup
icon: i-lucide-package
---

Most apps need only `vite-hub`. Install a single `@vite-hub/*` package for a library or a standalone integration.

## Framework distribution

| Package | Owns | Primary imports |
| --- | --- | --- |
| `vite-hub` | Framework defaults, the `vitehub()` Vite plugin, the tested compatibility matrix, and feature subpaths | `vite-hub`, `vite-hub/agent`, `vite-hub/env`, `vite-hub/workspace`, `vite-hub/workflow` |

The root export only sets up the framework. Runtime Helpers, Definitions,
Capabilities, and other app APIs come from feature subpaths.

## Independent owner packages

| Package | Owns | Primary imports |
| --- | --- | --- |
| `@vite-hub/agent` | Agent Definitions, Invocations, Drivers, Capabilities, Evals, and Triggers | `@vite-hub/agent`, `@vite-hub/agent/capabilities`, `@vite-hub/agent/channels`, `@vite-hub/agent/eval`, `@vite-hub/agent/vite` |
| `@vite-hub/auth` | Auth Definitions, Better Auth server setup, generated Auth routes | `@vite-hub/auth`, `@vite-hub/auth/server`, `@vite-hub/auth/vite` |
| `@vite-hub/blob` | Blob Stores, the default Blob Store, Blob Driver Modules, provider storage output | `@vite-hub/blob`, `@vite-hub/blob/vite`, `@vite-hub/blob/drivers/*` |
| `@vite-hub/browser` | Browser Definitions, per-invocation sessions, controllers, providers, live handoff, Browser Run output | `@vite-hub/browser`, `@vite-hub/browser/controllers/*`, `@vite-hub/browser/providers/*`, `@vite-hub/browser/vite` |
| `@vite-hub/bundle` | [Bundle reports](/docs/bundle) of production builds: client and server size, startup size, groups, and import chains, for Vite and Nuxt 5 with Nitro 3. The `vitehub bundle` commands. | `@vite-hub/bundle`, `@vite-hub/bundle/cli`, `@vite-hub/bundle/vite` |
| `@vite-hub/decisions` | [Decisions](/docs/decisions): `defineChoices()` turns text into choices from your options, for filters, search facets, and command palettes. Uses a gateway with `ask()`. No Vite or Nitro code. | `@vite-hub/decisions`, `@vite-hub/decisions/vue` |
| `@vite-hub/forge` | [Forge](/docs/forge): `useForge()` for GitHub App installation tokens and GitHub, GitLab, and Forgejo clients, the Forge Server Env, and the `forges` building blocks that ViteHub packages use | `@vite-hub/forge` |
| `@vite-hub/forms` | Forms that visitors send to the site owner: `defineForm()` with a spam guard, Standard Schema validation, a submissions table, and email. `submitForm()` on the client. | `@vite-hub/forms`, `@vite-hub/forms/client`, `@vite-hub/forms/database`, `@vite-hub/forms/vue` |
| `@vite-hub/sandbox` | Sandbox Definitions, execution sessions on any provider, Sandbox Tasks | `@vite-hub/sandbox`, `@vite-hub/sandbox/ssh`, `@vite-hub/sandbox/task`, `@vite-hub/sandbox/task/vite` |
| `@vite-hub/channels` | Channels in both directions (`defineChannel()`, `webhook()`, `stripe()`), server access, and Vite discovery | `@vite-hub/channels`, `@vite-hub/channels/server`, `@vite-hub/channels/vite` |
| `@vite-hub/cms` | The `cms` preset for Content collections, with the Workspace, tables, and Database it generates | `@vite-hub/cms`, `@vite-hub/cms/vite` |
| `@vite-hub/comments` | Comment threads on pages, anchors, the Comments API and overlay, presence rooms, in-place Content edits | `@vite-hub/comments`, `@vite-hub/comments/anchor`, `@vite-hub/comments/database`, `@vite-hub/comments/realtime`, `@vite-hub/comments/runtime`, `@vite-hub/comments/vite` |
| `@vite-hub/connections` | Connection Definitions, OAuth 2 grants, API keys, access rules, activity, typed Operations, Agent access | `@vite-hub/connections`, `@vite-hub/connections/google`, `@vite-hub/connections/server`, `@vite-hub/connections/agent`, `@vite-hub/connections/vite` |
| `@vite-hub/content` | Comark Content runtime, document collections, Source adaptation, server handler, typed client | `@vite-hub/content`, `@vite-hub/content/client`, `@vite-hub/content/database`, `@vite-hub/content/vite` |
| `@vite-hub/database` | Database Definitions, Drizzle schema generation, D1 and hosted database setup | `@vite-hub/database`, `@vite-hub/database/vite` |
| `@vite-hub/docs` | Docs sites from a Markdown folder: frontmatter, navigation, shell, theme, search, raw Markdown, llms.txt, MCP server, assistant | `@vite-hub/docs`, `@vite-hub/docs/nuxt`, `@vite-hub/docs/server`, `@vite-hub/docs/navigation`, `@vite-hub/docs/assistant`, `@vite-hub/docs/primitive-rail` |
| `@vite-hub/email` | Provider setup, built-in transports, runtime delivery, Dynamic Markdown, test capture | `@vite-hub/email`, `@vite-hub/email/markdown`, `@vite-hub/email/test`, `@vite-hub/email/vite` |
| `@vite-hub/env` | Env Declarations, Public, Server, and Secret Env, generated env access | `@vite-hub/env`, `@vite-hub/env/vite`, `@vite-hub/env/server`, `@vite-hub/env/bridge`, `@vite-hub/env/database`, `@vite-hub/env/seal` |
| `@vite-hub/gateways` | [AI Gateways](/docs/gateways): Driver routes for Codex and Claude Code, AI SDK models with `languageModel()`, `ask()` and its question builders for TypeSafe Jev. No Agent, Vite, or Nitro code. | `@vite-hub/gateways`, `@vite-hub/gateways/ai-sdk` |
| `@vite-hub/i18n` | [i18n](/docs/i18n): messages in the source language with no keys, PO catalogs, message IDs at build time, and one locale for each request on Nitro 3 | `@vite-hub/i18n`, `@vite-hub/i18n/vue`, `@vite-hub/i18n/vite`, `@vite-hub/i18n/nuxt` |
| `@vite-hub/kit` | The headless Vue parts that [ui-sdk](https://ui-sdk.dev) does not have, a Nuxt module that auto-imports them, and a plain CSS style family on shadcn token names. Import every other part from `@ui-sdk/vue`. | The `tags-input`, `form`, and `nuxt` subpaths, and `styles/tokens.css` and `styles/default.css` |
| `@vite-hub/kv` | KV Runtime Helper and configured KV Stores | `@vite-hub/kv`, `@vite-hub/kv/vite` |
| `@vite-hub/markdown-template` | Markdown with data bindings, conditions, and fragments | `@vite-hub/markdown-template` |
| `@vite-hub/mcp` | [MCP server](/docs/mcp): app MCP server, tool Definitions, Standard Schema validation, and MCP OAuth integration | `@vite-hub/mcp`, `@vite-hub/mcp/vite` |
| `@vite-hub/queue` | Queue Definitions, dispatch helpers, provider queue output | `@vite-hub/queue`, `@vite-hub/queue/vite` |
| `@vite-hub/rate-limit` | Rate Limit declarations, runtime decisions, drivers, provider output | `@vite-hub/rate-limit`, `@vite-hub/rate-limit/runtime`, `@vite-hub/rate-limit/drivers/*`, `@vite-hub/rate-limit/vite` |
| `@vite-hub/realtime` | Realtime documents, server routes, history, Vue bindings | `@vite-hub/realtime`, `@vite-hub/realtime/server`, `@vite-hub/realtime/vue`, `@vite-hub/realtime/vite` |
| `@vite-hub/runtime` | Runtime Host Context, Capability handles, Policy Decisions, approvals, Trace Events, leases | `@vite-hub/runtime` |
| `@vite-hub/schedule` | Static schedules, manual runs, cron Provider Output | `@vite-hub/schedule`, `@vite-hub/schedule/runtime`, `@vite-hub/schedule/vite` |
| `@vite-hub/shell` | Shell execution providers and Workspace shell helpers | `@vite-hub/shell`, `@vite-hub/shell/workspace` |
| `@vite-hub/source` | Source Definitions and Loaders for file, glob, markdown, GitHub, custom, and MCP resources | `@vite-hub/source`, `@vite-hub/source/*` |
| `@vite-hub/ui` | AI SDK Vue and Nuxt components, headless message scrolling, shadcn/ui parts, Pierre code views | `@vite-hub/ui`, `@vite-hub/ui/headless`, `@vite-hub/ui/markdown-editor`, `@vite-hub/ui/workspace`, `@vite-hub/ui/playground`, `@vite-hub/ui/theme`, `@vite-hub/ui/vite` |
| `@vite-hub/web-container` | [WebContainer](/docs/web-container): WebContainer lifecycle, app commands, preview status, snapshots, isolation headers, connection metadata | `@vite-hub/web-container`, `@vite-hub/web-container/vue`, `@vite-hub/web-container/vite`, `@vite-hub/web-container/env`, `@vite-hub/web-container/connect` |
| `@vite-hub/workflow` | Workflow Definitions, durable run state, steps, provider workflow output | `@vite-hub/workflow`, `@vite-hub/workflow/vite` |
| `@vite-hub/workspace` | Workspace Definitions, Stores, history contracts, Source Bindings, runtime facades, extensions | `@vite-hub/workspace`, `@vite-hub/workspace/vite`, `@vite-hub/workspace/runtime` |

## Internal and support packages

| Package | Status | Purpose |
| --- | --- | --- |
| `@vite-hub/cli` | Public CLI package | Loads the Vite config and runs each package's CLI commands. |
| `@vite-hub/codemods` | Public CLI package | [Codemods](/docs/codemods) that migrate apps to ViteHub with `npx @vite-hub/codemods <codemod>`, for example from `nuxt-safe-runtime-config` to Env. |
| `@vite-hub/console` | Private app, not published | Console server with sign-in, linked projects, and a forward to each project's Operations endpoint. The Console page is in progress. |
| `@vite-hub/icons` | Internal package | The ViteHub icon set (`i-vitehub-*`). `@vite-hub/ui` and the Console bundle it. Not published. |
| `@vite-hub/internal` | Internal package | Shared discovery, Provider Output, provisioning, runtime, and build helpers. |

## Package rules

- Apps use `vite-hub` and its documented feature imports.
- Libraries and single integrations can depend on one `@vite-hub/*` package.
- Do not import `@vite-hub/internal`, generated files, or framework virtual modules unless a reference page documents that path.
- Provider code lives in the package that owns the primitive. For example, Blob Provider SDK Adapters sit behind Blob Driver Modules. Workspace Provider Adapters sit behind Workspace config and generated runtime wiring.

## Package tutorials

- [Build your first UI view](/docs/ui/get-started) for `@vite-hub/ui`.
- [Run your first Sandbox](/docs/agents/sandbox-tutorial) for `@vite-hub/sandbox`.
- [Render your first Markdown template](/docs/reference/markdown-template-tutorial) for `@vite-hub/markdown-template`.

## Related

- [Import paths](/docs/reference/import-paths)
- [Config options](/docs/reference/config-options)
- [Provider output](/docs/reference/provider-output)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)

- `@vite-hub/presets`
