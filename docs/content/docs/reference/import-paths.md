---
title: Import paths
description: Which ViteHub imports are stable, and which paths are generated or internal.
navigation.order: 51
navigation.group: Setup
icon: i-lucide-route
---

Stable import paths are the ViteHub imports your app may use. Behind them can be registries, generated files, virtual modules, or package code. Do not depend on what is behind them.

## Canonical application imports

With `vite-hub` installed, import `vitehub()` from the root and app APIs from feature subpaths.

| Import path | Use |
| --- | --- |
| `vite-hub` | `vitehub()`, the framework Vite plugin. |
| `vite-hub/deployment` | `detectPreset()`: the preset `vitehub()` detects when `preset` is omitted. Use it for host-specific config. |
| `vite-hub/skills` | Define and serve [Agent Skills](/docs/development/skills) through HTTP discovery and MCP. |
| `vite-hub/agent/vite` | Process Agent host, and generated health and Workspace routes, for Vite. |
| `vite-hub/agent` | Agent Definition, invocation, trigger, and Agent Actor APIs. |
| `vite-hub/agent/capabilities` | Official Capability factories. |
| `vite-hub/agent/channels` | Official Channel Kind helpers. |
| `vite-hub/agent/eval` | Agent Eval helpers. Install Evalite and the test runner yourself. |
| `vite-hub/agent/observability` | `useObservability()` for the instance configured by `vitehub({ observability })`. |
| `vite-hub/logs` | Evlog's logger API and readable LogSource helpers. Requires the optional `evlog` peer. |
| `vite-hub/logs/source` | Server-side LogSource contract, query validation, and cursor errors without Evlog. |
| `vite-hub/logs/memory` | Bounded local buffer for an existing redacted drain. Runs without Evlog, but its types need `evlog`. |
| `vite-hub/logs/host` | Install and resolve a project's LogSource in the process-wide registry, without Evlog. |
| `vite-hub/agent/cloudflare` | Cloudflare Agent state helpers. |
| `vite-hub/agent/vue` | Vue Agent client handle and AI SDK chat composable. |
| `vite-hub/agent/server` and `vite-hub/agent/state/sqlite` | Manual server integration and libSQL-compatible durable Agent state. |
| `vite-hub/agent/server/github` | GitHub host access, App credentials, command execution, and checkout lifecycle. |
| `vite-hub/agent/process-host` | Attach a long-running Node process host to an Agent Definition from a preset. |
| `vite-hub/decisions` | [`defineChoices()`](/docs/decisions/server-api): turns text into choices from options you declare. Re-exports `@vite-hub/decisions`. |
| `vite-hub/decisions/vue` | [`useChoices()`](/docs/decisions/client): Vue selection state, optional debounce, and cancellation for your resolver. Re-exports `@vite-hub/decisions/vue`. Auto-imported in Nuxt. |
| `vite-hub/gateways` | [AI gateways](/docs/agents/ai-gateways): routes for Codex and Claude Code model requests, and `ask()` for TypeSafe Jev questions. Re-exports `@vite-hub/gateways`. |
| `vite-hub/gateways/ai-sdk` | [`languageModel()`](/docs/agents/ai-gateways#use-a-model-with-the-ai-sdk): an AI SDK model that sends requests through a gateway. Re-exports `@vite-hub/gateways/ai-sdk`. |
| `vite-hub/presets/babysitter` | Composable Babysitter repair-loop preset. |
| `vite-hub/presets/babysitter/server` | Babysitter host runtime integration. |
| `vite-hub/presets/labeller` | Gmail labelling preset with ordered rules, Jev fallback, and allowlisted message actions. |
| `vite-hub/presets/workspace` | Opt-in preset that cites where Workspace sources come from. |
| `vite-hub/agent/invocations/d1` | Cloudflare D1 Agent Invocation Journal and its schema statements. |
| `vite-hub/agent/invocations/database` | Agent Invocation Journal backed by a ViteHub SQLite database. |
| `vite-hub/agent/invocations/sqlite` | LibSQL-compatible durable Agent Invocation Journal. |
| `vite-hub/agent/mcp` | MCP Server configuration helpers. |
| `vite-hub/agent/runtime/process` | Adaptive per-process Agent capacity for self-hosted Node apps. |
| `vite-hub/console` | Route metadata for the local read-only invocation console. |
| `vite-hub/console/auth` | Define a Console-owned Auth Definition and its access policy. |
| `vite-hub/console/auth/client` | Configure Console Auth client plugins and setup. |
| `vite-hub/console/auth/cloudflare-access` | Verify Cloudflare Access tokens for the Console guard. |
| `vite-hub/console/auth/inline` | Build the Node-only inline GitHub Console Auth Definition. |
| `vite-hub/console/blob` | Registers read-only Blob inspection for framework servers. |
| `vite-hub/console/database` | Registers read-only Database inspection for framework servers. |
| `vite-hub/console/documents` | Registers the Content document editor for framework servers. |
| `vite-hub/console/definitions` | Registers read-only Definition inspection for framework servers. |
| `vite-hub/console/env` | Registers the Server Env declaration list for framework servers. |
| `vite-hub/console/mcp-client` | Console MCP client operations. The generated Console plugin installs them when `console.mcpClient` is on. |
| `vite-hub/console/sections` | Registers the Console section manifest for framework servers. |
| `vite-hub/console/server` | Local Console invocation journal for servers. |
| `vite-hub/console/ui` | Agent Invocation views from the Console: `AgentInvocation`, `AgentInvocationList`, and `AgentCapabilityInspector`. |
| `vite-hub/content`, `vite-hub/content/client`, `vite-hub/content/database`, `vite-hub/content/editor`, and `vite-hub/content/realtime` | Comark Content definition, editable document collections, every field helper (`image()`, `file()`, `seo()`, `optional()`), Source adaptation, generated runtime handler, typed client, editor codecs, realtime collaboration, and the sessions table schema. |
| `vite-hub/cms` | The `cms` preset, which stores document collections in a Workspace it adds. |
| `vite-hub/cms/access` | CMS roles for the Better Auth `admin` plugin, `admin(cmsAccess)`, and their policies: `cmsCan()`, `cmsContentAuthorize`, `cmsCommentsAuthorize`, `cmsConsoleAuthorize`. |
| `vite-hub/cms/vite` | `hubCms()`, the Vite plugin that adds the `cms` Workspace, its tables, and a Database if the app has none. `vitehub()` registers it. |
| `vite-hub/docs/nuxt` | The Nuxt module of a [docs site](/docs/docs-site): pages from a Markdown folder, the docs shell and theme, search, and agent resources. Re-exports `@vite-hub/docs/nuxt`. |
| `vite-hub/docs` | Docs site frontmatter schema, manifest types, and navigation helpers. Re-exports `@vite-hub/docs`. |
| `vite-hub/docs/assistant` | `docsAssistant`, the Agent preset that answers reader questions from the docs, and `docsRateLimit()`. Re-exports `@vite-hub/docs/assistant`. |
| `vite-hub/auth` and `vite-hub/auth/server` | Auth Definitions and server runtime helpers. |
| `vite-hub/auth/mcp` | OAuth sign-in, discovery, request checks, and unused-client cleanup for an app's MCP server. Needs `@better-auth/oauth-provider`. |
| `vite-hub/auth/database` | `authDatabase()` connects Better Auth to an app Database and adds its tables to generated migrations. |
| `vite-hub/auth/schema` | `authSqliteSchema` and `authPostgresSchema`, the Better Auth tables for SQLite and Postgres. |
| `vite-hub/auth/runtime/server` | Light Auth resolver registration and lazy access middleware, without loading Better Auth. |
| `vite-hub/auth/console` | Auth Console section descriptor and management types. |
| `vite-hub/auth/console-runtime` | `createAuthConsole()` for trusted manual server hosts. |
| `vite-hub/auth/presets` | Auth presets, such as `stateless()` for sessions without a database. |
| `vite-hub/auth/agent` | Maps Better Auth sessions to Agent Invokers. |
| `vite-hub/auth/vue` | Better Auth Vue client and session composables. |
| `vite-hub/blob` | Blob Runtime Helpers, Blob Store access, and the `image()` and `file()` Blob reference schemas. |
| `vite-hub/blob/client` | Browser upload helpers for any framework: `uploadFiles()` and `createMultipartUploader()`. |
| `vite-hub/blob/content-type` | Detect common image and PDF signatures from leading bytes before upload. |
| `vite-hub/blob/media` | Browser-safe media helpers: `responsiveImage()`, `imageVariantUrl()`, `parseImageVariant()`, and `probeImage()`. |
| `vite-hub/blob/vue` | Vue upload composables: `useUpload()` and `useMultipartUpload()`. |
| `vite-hub/browser` | Browser Definitions, invocation-scoped Playwright sessions, and named Browser runs. |
| `vite-hub/web-container` | Boot and mount a WebContainer in the browser, run app commands, read preview status, and export snapshots. Re-exports `@vite-hub/web-container`. |
| `vite-hub/web-container/connect` | Static connection-provider metadata, and mapping of credentials to process env, with `defineConnect()` and `connectEnv()`. Re-exports `@vite-hub/web-container/connect`. |
| `vite-hub/browser/actions` | ViteHub Browser actions backed by Cloudflare Browser Run. |
| `vite-hub/browser/controllers/cdp` and `vite-hub/browser/controllers/playwright` | Raw CDP and Playwright Browser Session controllers (advanced). |
| `vite-hub/browser/providers/cloudflare` and `vite-hub/browser/providers/local` | Pick a provider for low-level Browser Clients (advanced). |
| `vite-hub/channels` and `vite-hub/channels/server` | Outbound Channel Definitions with `defineOutboundChannel()`, and delivery by name. |
| `vite-hub/comments` | `defineComments()` for `server/comments.ts`, as the `comments` export or the default export. One definition runs the overlay, Comments API, presence, MCP, and [comment operations](/docs/comments/operations/get-started). |
| `vite-hub/comments/anchor`, `vite-hub/comments/database`, `vite-hub/comments/realtime`, `vite-hub/comments/runtime`, and `vite-hub/comments/runtime/auth` | Browser pin anchors, the Comments tables, and the presence room, API handler, Nitro plugin, and Auth session reader that generated output imports. |
| `vite-hub/comments/client`, `vite-hub/comments/rpc`, `vite-hub/comments/server`, and `vite-hub/comments/database/postgres` | The operations browser client and anchors, RPC transport, server runtime, and Postgres tables. |
| `vite-hub/page/pill.js` | The page pill of ViteHub's page tools, as a classic browser script that declares `ViteHubPagePill`. Paste it as text into your own page script, for example with a Vite `?raw` import. It has no module exports. |
| `vite-hub/connections`, `vite-hub/connections/google`, and `vite-hub/connections/server` | Connection Definitions, the Google preset with typed Gmail Operations, and runtime access. |
| `vite-hub/connections/chatgpt` | The `chatgpt()` Connection provider, to sign in with a ChatGPT plan. |
| `vite-hub/connections/agent` and `vite-hub/connections/http` | Agent primitive handle, and the management and OAuth routes that the Console mounts. |
| `vite-hub/sandbox` | Sandbox Definitions and built-in runtimes: trusted host, Crabbox, Cloudflare Sandbox, and Vercel Sandbox. |
| `vite-hub/sandbox/ssh` | `sshLaunch` for provider Driver launch callbacks and `serveSsh` for a trusted SSH runner. |
| `vite-hub/database` and `vite-hub/database/drizzle` | Database Definitions and generated `useDatabase()` access. |
| `vite-hub/env` | Env Declaration helpers and authoring types. |
| `vite-hub/env/http` | Authenticated HTTP adapter for declared Env Bridge credentials. |
| `vite-hub/env/auth` | Env Bridge authentication adapters |
| `vite-hub/env/bridge` | Runtime credential replacement, scoped grants, and durable activity. |
| `vite-hub/env/database` | Encrypted Env Bridge storage on ViteHub SQLite/Drizzle databases. |
| `vite-hub/env/provider` | Read-only runtime providers for your own external Env storage. |
| `vite-hub/email`, `vite-hub/email/server`, and `vite-hub/email/markdown` | Email clients, runtime delivery, and Dynamic Markdown HTML with a Markdown text fallback. |
| `vite-hub/env/presets` and `vite-hub/env/schema` | Reusable Env presets and schema helpers. |
| `vite-hub/env/secret` and `vite-hub/env/server` | Secret declarations and server-only Env access. |
| `vite-hub/env/seal` | AES-GCM `seal`, `unseal`, `importSealKey`, and `sealKeyId` in the Env Bridge database store format. |
| `vite-hub/kv` | KV Runtime Helper. |
| `vite-hub/markdown-template` | Portable Markdown rendering from template strings. |
| `vite-hub/markdown-template/file` | Filesystem Markdown rendering from explicit file paths or `file:` URLs. |
| `vite-hub/operations` | `defineOperation()` and its types. See [Operations](/docs/development/operations). |
| `vite-hub/queue` | Queue Definitions and dispatch helpers. |
| `vite-hub/rate-limit` | Rate Limit handles declared in your source, and direct Rate Limiters. |
| `vite-hub/realtime`, `vite-hub/realtime/server`, and `vite-hub/realtime/vue` | Realtime Definitions, manual server integration, and Vue collaborative editing, saved through [Realtime document adapters](/docs/realtime/server-api#custom-document-adapters). |
| `vite-hub/runtime` | Runtime Host Context, policy, approval, trace, and capability APIs. |
| `vite-hub/runtime/h3` | H3 Runtime Context adapter, Standard Context types, `getStandardContext()`, and `installStandardContext()`. |
| `vite-hub/runtime/node` | Node process, host, and Linux cgroup resource observations. |
| `vite-hub/sandbox` | Sandbox Definitions and Sandbox Run helpers. |
| `vite-hub/sandbox/task` | Sandbox Task Definitions and `runSandboxTask()`. |
| `vite-hub/schedule` and `vite-hub/schedule/runtime` | Static Schedule Definitions, manual runs, and Schedule Run stores. |
| `vite-hub/schedule/runtime/process` | Process Runtime that runs Static Schedules in a long-lived Node process. |
| `vite-hub/schedule/runtime/kv` | ViteHub KV storage adapter for Schedule Runs. |
| `vite-hub/shell` | Shell runtime and command analysis APIs. |
| `vite-hub/shell/providers/just-bash` | Just Bash Shell provider. |
| `vite-hub/shell/workspace` | Workspace-backed Shell execution helpers. |
| `vite-hub/task` | Nitro `defineTask()` and `runTask()` for `server/tasks/` files. |
| `vite-hub/source` | Runtime-neutral Source Definitions, custom loaders, registry APIs, and Collections (`defineCollection`, `array`, `table`). |
| `vite-hub/source/client` and `vite-hub/source/server` | Vue Collection pagination and the H3 Collection route adapter. |
| `vite-hub/source/file`, `vite-hub/source/glob`, and `vite-hub/source/markdown` | Local file implementations, loaded only when selected. |
| `vite-hub/source/files` | `files()`, the Source that `glob()` becomes in a server build, with the matched files bundled at build time. |
| `vite-hub/source/github` | GitHub Source implementation, loaded only when selected. |
| `vite-hub/source/mcp` | MCP Resources implementation with its private SDK closure. |
| `vite-hub/source/vite` | Source discovery, generated artifacts, and Nitro route integration for custom Vite plugin composition. |
| `vite-hub/ui`, `vite-hub/ui/headless`, and `vite-hub/ui/styles.css` | AI interface components, headless message scrolling, and default styles. |
| `vite-hub/ui/chat`, `vite-hub/ui/chat-message`, `vite-hub/ui/prompt-input`, `vite-hub/ui/message-parts`, `vite-hub/ui/markdown`, `vite-hub/ui/chat-session` | Focused imports for chat components. |
| `vite-hub/ui/filter-search` and `vite-hub/ui/choices-input` | The `FilterSearch` text box for `useChoices()`, and its headless parts. |
| `vite-hub/ui/markdown-editor` | `MarkdownEditor` with uploads to Blob. Kept out of the root import, so it loads Tiptap only where you use it. |
| `vite-hub/ui/message`, `vite-hub/ui/bubble`, `vite-hub/ui/marker`, `vite-hub/ui/attachment`, `vite-hub/ui/trace`, `vite-hub/ui/code-block` | shadcn/ui part families. |
| `vite-hub/ui/tool-list`, `vite-hub/ui/trace-run` | Focused imports for tool contract and trace run components. |
| `vite-hub/ui/code-view`, `vite-hub/ui/file-view`, `vite-hub/ui/file-diff`, `vite-hub/ui/multi-file-diff`, `vite-hub/ui/patch-diff`, `vite-hub/ui/unresolved-file` | Focused imports for code and diff components. |
| `vite-hub/ui/file-tree` | Focused import for the file tree component. |
| `vite-hub/ui/avatar-stack`, `vite-hub/ui/comments`, `vite-hub/ui/connection-status`, `vite-hub/ui/sync-status` | Focused imports for collaboration components. |
| `vite-hub/ui/nuxt` and `vite-hub/ui/vite` | Register the UI package for Nuxt, or for Vue with Vite. |
| `vite-hub/tsconfig` | TypeScript config that includes ViteHub's generated types and leaves your source `include` to you. |
| `vite-hub/workflow` | Workflow Definitions and run helpers. |
| `vite-hub/workspace` and `vite-hub/workspace/runtime` | Workspace Definitions, Sources, history contracts, runtime facades, registry APIs, and the `workspaceFile()` Collection source. |
| `vite-hub/workspace/files` | `useWorkspaceFiles()` for file and history access without constructing Agent tools. |
| `vite-hub/workspace/cloudflare` | Cloudflare Workspace runtime setup. |
| `vite-hub/workspace/blob-database` | Content-addressed Workspace history Store and Database schema. Requires `drizzle-orm`. |
| `vite-hub/workspace/loader` and `vite-hub/workspace/server` | Workspace loader and manual server extension APIs. |

ViteHub adapters use `vite-hub/*` imports. You install their optional third-party providers and SDKs yourself. Provider Output, build plugins, tests, and provider modules not listed here stay in their own packages.

## Direct owner-package imports

You can install each package on its own. These paths are stable for libraries, single integrations, and advanced setups.

| Import path | Use |
| --- | --- |
| `@vite-hub/agent` | Agent Definition, invocation, and trigger helpers, and trusted caller types. |
| `@vite-hub/agent/capabilities` | Official Capability factories such as `access()`, `browser()`, `workspaceShell()`, and `inputCommands()`. |
| `@vite-hub/agent/channels` | Official Channel Kind helpers such as `github()`, `teams()`, `telegram()`, `webChat()`, and `defineChannel()`. |
| `@vite-hub/agent/observability` | `useObservability()` and observability types. |
| `@vite-hub/agent/process-host` | `withAgentProcessHost()` and webhook intake for preset process hosts. |
| `@vite-hub/presets/babysitter` | Composable Babysitter repair-loop preset. |
| `@vite-hub/presets/babysitter/server` | Babysitter host runtime integration. |
| `@vite-hub/presets/labeller` | Gmail labelling preset. |
| `@vite-hub/presets/workspace` | Opt-in preset that cites where Workspace sources come from. |
| `@vite-hub/agent/observability/host` | `installObservability()` for hosts without `vitehub()`. |
| `@vite-hub/agent/observability/posthog` | Optional PostHog exporter. |
| `@vite-hub/agent/eval` | Agent Eval authoring helpers. |
| `@vite-hub/agent/runtime/process` | Adaptive per-process Agent capacity for self-hosted Node apps. |
| `@vite-hub/agent/test` | Test runner helpers for Agent Invocation checks, locally and in CI. |
| `@vite-hub/agent/cloudflare` | Cloudflare Agent state helpers. |
| `@vite-hub/agent/vue` | Vue Agent client handle and AI SDK chat composable. |
| `@vite-hub/auth` | Auth Definition helpers. |
| `@vite-hub/auth/server` | Better Auth runtime, request handlers, and session access for manual hosts. |
| `@vite-hub/auth/mcp` | MCP OAuth helpers for manual hosts, with the optional `@better-auth/oauth-provider` peer. |
| `@vite-hub/auth/runtime/server` | Light Auth resolver registration and lazy access middleware for framework integrations. |
| `@vite-hub/blob` | Blob Runtime Helpers, Blob Store access, and Blob reference schemas. |
| `@vite-hub/blob/client` | Browser upload helpers for any framework. |
| `@vite-hub/blob/content-type` | Detect common image and PDF signatures from leading bytes before upload. |
| `@vite-hub/blob/media` | Browser-safe media helpers for responsive images and variant URLs. |
| `@vite-hub/blob/vue` | Vue upload composables. |
| `@vite-hub/browser` | Browser Definitions, invocation-scoped sessions, and low-level Browser Client lifecycle. |
| `@vite-hub/browser/actions` | ViteHub Browser actions backed by Cloudflare Browser Run. |
| `@vite-hub/browser/controllers/cdp` and `@vite-hub/browser/controllers/playwright` | Raw CDP and Playwright Browser Session controllers. |
| `@vite-hub/browser/providers/cloudflare` and `@vite-hub/browser/providers/local` | Cloudflare Browser Run and local Chromium providers. |
| `@vite-hub/sandbox` | Sandbox Definitions, sessions, and built-in runtime selection. |
| `@vite-hub/sandbox/ssh` | `sshLaunch` and `serveSsh` for a trusted SSH command transport. |
| `@vite-hub/channels` | Outbound Channel Definitions with `defineOutboundChannel()`, explicit clients, portable types, and delivery results. |
| `@vite-hub/channels/server` | Server-only delivery by name. |
| `@vite-hub/comments` | `defineComments()`, `installComments()`, the runtime methods, and portable types. |
| `@vite-hub/comments/anchor` | Browser helpers that create and place pin [anchors](/docs/comments/server-api#anchors). |
| `@vite-hub/comments/database` | `commentsSchema` (the Comments tables), and `migrateComments()` with `commentsMigrationSql()` to migrate the live-site tables. |
| `@vite-hub/comments/realtime` and `@vite-hub/comments/runtime` | The presence room definition, the Comments API handler, and the Nitro plugin that generated output imports. |
| `@vite-hub/connections` and `@vite-hub/connections/google` | Connection Definitions, `apiKey()`, the Google preset, and typed Gmail Operations. |
| `@vite-hub/connections/chatgpt` | The `chatgpt()` Connection provider, to sign in with a ChatGPT plan. |
| `@vite-hub/connections/server`, `@vite-hub/connections/http`, and `@vite-hub/connections/agent` | Runtime access with `useConnection()`, management and OAuth routes, and the Agent primitive handle. |
| `@vite-hub/comments/client`, `@vite-hub/comments/rpc`, `@vite-hub/comments/server`, and `@vite-hub/comments/database/postgres` | The operations browser client and anchors, RPC transport, server runtime, and Postgres tables. |
| `@vite-hub/comments/operations` | The `comments.*` operations. The framework distribution imports them for you. |
| `@vite-hub/content`, `@vite-hub/content/client`, and `@vite-hub/content/database` | Comark Content runtime, document collections with drafts and publishing, Source adaptation, server handler, typed client, and the sessions table schema. |
| `@vite-hub/cms` and `@vite-hub/cms/vite` | The `cms` preset, which stores document collections in a Workspace it adds, and `hubCms()`, the Vite plugin that adds that Workspace, its tables, and a Database if the app has none. |
| `@vite-hub/cms/access` | CMS roles for the Better Auth `admin` plugin, and their policies. Needs `better-auth`. |
| `@vite-hub/docs/nuxt` | The Nuxt module of a [docs site](/docs/docs-site). |
| `@vite-hub/docs` and `@vite-hub/docs/navigation` | Frontmatter schema, manifest types, and navigation helpers. |
| `@vite-hub/docs/server` | `createDocsManifest()`, the Markdown parser, and `toRawMarkdown()`, for tools and tests that read a content folder without Nuxt. |
| `@vite-hub/docs/assistant` | `docsAssistant` and `docsRateLimit()`. Needs `@vite-hub/agent`. |
| `@vite-hub/cli` | The `vitehub` command and its programmatic entry. Apps use `vite-hub` instead. |
| `@vite-hub/email` | Explicit clients, portable types, and normalized errors. |
| `@vite-hub/email/server` | Server-only `email` Runtime Helper. |
| `@vite-hub/email/markdown` | Dynamic Markdown to HTML, with a Markdown text fallback. |
| `@vite-hub/email/test` | In-memory message capture for tests. |
| `#vitehub/emails/<name>` | Generated async renderer for a discovered `server/emails/**/*.md` template. |
| `@vite-hub/database` and `@vite-hub/database/drizzle` | Database Definition helpers and generated `useDatabase()` access to a Drizzle database and schema. |
| `@vite-hub/env` | Env Declaration helpers. |
| `@vite-hub/env/auth` | Env Bridge authentication adapters. |
| `@vite-hub/env/http` | Authenticated HTTP adapter for declared credentials. |
| `@vite-hub/env/bridge` | Runtime credential replacement, scoped grants, and durable activity. |
| `@vite-hub/env/database` | Encrypted SQLite/Drizzle storage for Env Bridge. |
| `@vite-hub/env/provider` | Read-only runtime providers for your own external Env storage. |
| `@vite-hub/env/seal` | AES-GCM helpers in the Env Bridge database store format. |
| `#vitehub/env/public` | Generated Public Env access. |
| `#vitehub/env/server` | Generated Server Env access. |
| `@vite-hub/kv` | KV Runtime Helper. |
| `@vite-hub/markdown-template` | Portable Markdown rendering from template strings. |
| `@vite-hub/markdown-template/file` | Filesystem Markdown rendering from explicit file paths or `file:` URLs. |
| `@vite-hub/queue` | Queue Definition and enqueue Runtime Helper. |
| `@vite-hub/rate-limit` | Rate Limit handles declared in your source, and direct Rate Limiters. |
| `@vite-hub/rate-limit/drivers/memory` | Fixed-window limits for local, test, and single-process use. |
| `@vite-hub/rate-limit/drivers/cloudflare` | Direct access to a Cloudflare Rate Limiting binding. |
| `@vite-hub/realtime` | Realtime Definitions and portable collaboration types. |
| `@vite-hub/realtime/server` and `@vite-hub/realtime/vue` | Manual server integration and Vue collaborative editing. |
| `@vite-hub/realtime/client` | `connectRealtimeRoom()`, presence in one room without an editor or Vue. |
| `@vite-hub/runtime` | Runtime Host Context, capability handles, policy, approvals, traces, leases, and execution authority. |
| `@vite-hub/runtime/node` | Node process and host resource observations. |
| `@vite-hub/shell` | Command analysis and provider-neutral Shell runtime execution. |
| `@vite-hub/shell/providers/just-bash` | Just Bash Shell provider. |
| `@vite-hub/shell/workspace` | Read-only Workspace filesystem adapters and mount paths for Shell providers. |
| `@vite-hub/ui`, `@vite-hub/ui/<name>`, and `@vite-hub/ui/headless` | AI SDK-native Vue components, shadcn/ui parts, and headless message scrolling. |
| `@vite-hub/sandbox/task` | Sandbox Task Definitions and `runSandboxTask()`. |
| `@vite-hub/schedule` and `@vite-hub/schedule/runtime` | Schedule Definition helpers, manual runs, and Schedule Run stores. |
| `@vite-hub/schedule/runtime/kv` | KV storage adapter. Needs the optional `@vite-hub/kv` peer. |
| `@vite-hub/schedule/runtime/process` | Process Runtime that runs Static Schedules in a long-lived Node process. |
| `#vitehub/schedule/registry` | Generated static schedule registry for host bridges. |
| `@vite-hub/workflow` | Workflow Definition and run helpers. |
| `@vite-hub/source` | Source Definitions, loaders, and registry APIs. |
| `@vite-hub/workflow/runtime/openworkflow-worker` | OpenWorkflow worker lifecycle helpers. Install `openworkflow` yourself. |
| `@vite-hub/workspace` | Workspace Definition, Source helpers, history contracts, Workspace facade access, and authoring types. |
| `@vite-hub/workspace/files` | `useWorkspaceFiles()` for file and history access without constructing Agent tools. |
| `@vite-hub/workspace/runtime` | Workspace runtime registry, `useWorkspace()`, and source resolution and request helpers for integrations. |

## Integration imports

| Import path | Use |
| --- | --- |
| `vite-hub` | The app import for `vitehub()`. |
| `vite-hub/nuxt` | The Nuxt module. It passes the Vite plugin config to Nitro. |
| `vite-hub/doctor` | ViteHub [Doctor rules](/docs/reference/doctor-rules) for Vite Doctor. `vitehub()` and `vite-hub/nuxt` register it. |
| `@vite-hub/agent/vite` | The Agent Vite plugin. |
| `@vite-hub/auth/vite` | The Auth Vite plugin. |
| `@vite-hub/blob/vite` | The Blob Vite plugin. |
| `@vite-hub/browser/vite` | Cloudflare Browser Run Provider Output. |
| `@vite-hub/channels/vite` | Channel discovery and generated runtime bindings. |
| `@vite-hub/comments/vite` | Discovers `server/comments.ts`, then registers the live-site API or Comment operations, its Database tables, and the Console section. |
| `@vite-hub/connections/vite` | Connection discovery and the generated runtime module. |
| `@vite-hub/content/vite` | The `vitehub content` commands, Content operations, and the Content inspector. |
| `@vite-hub/database/vite` | The Database Vite plugin. |
| `@vite-hub/email/vite` | Sets up one built-in Email provider and its runtime binding. |
| `@vite-hub/env/vite` | The Env Vite plugin and the `env()` declaration helper. |
| `@vite-hub/ui/nuxt` and `@vite-hub/ui/vite` | The UI package for Nuxt, or for Vue with Vite. |
| `@vite-hub/kv/vite` | The KV Vite plugin. |
| `@vite-hub/queue/vite` | The Queue Vite plugin. |
| `@vite-hub/rate-limit/vite` | Rate Limit source collection and Provider Output. |
| `@vite-hub/realtime/vite` | Realtime discovery and generated runtime wiring. |
| `@vite-hub/sandbox/task/vite` | The Sandbox Task Vite plugin. |
| `@vite-hub/schedule/vite` | The Schedule Vite plugin. |
| `@vite-hub/source/vite` | Source discovery, generated files, and Nitro routes. |
| `@vite-hub/workflow/vite` | The Workflow Vite plugin. |
| `@vite-hub/workspace/vite` | The Workspace Vite plugin. |

If you use `@vite-hub/source/vite` directly, extend `@vite-hub/source/tsconfig`. It includes the generated Collection registry, so you need no framework TypeScript entry or `.vitehub` glob.

TypeScript replaces inherited arrays. If you set your own `rootDirs` or `files`, keep the generated Source types in `include`:

```json
{
  "extends": ["@vite-hub/source/tsconfig"],
  "include": ["src", ".vitehub/types/source/**/*.d.ts"]
}
```

## Generated and internal paths

| Path family | Status | Guidance |
| --- | --- | --- |
| `.vitehub/**` | Generated | Inspect in dev. Do not import these files. |
| `.vercel/output/**` | Generated Provider Output | Deploy or inspect as Vercel Build Output. |
| `.netlify/v1/**` | Generated Provider Output | Deploy or inspect as Netlify function output. |
| `dist/**/wrangler.json` | Generated Provider Output | Deploy or inspect as Cloudflare output. |
| Vite virtual module ids with `\0` prefixes | Internal | Never import directly. |
| `vite-hub/_internal/*` | Internal | Only for generated ViteHub code. Apps must not import it. |
| `@vite-hub/internal/*` | Internal | Package implementation only. |

There is no `@vite-hub/agent/netlify` import. Netlify Agent output is generated Provider Output in `.netlify/v1`, plus the `.vitehub/agent/netlify-function.mjs` wrapper. With Nuxt, the wrapper is at `<buildDir>/vitehub/agent/netlify-function.mjs` (usually `.nuxt/vitehub/agent/netlify-function.mjs`).

`vite-hub` adds `vite-hub/source/vite` for custom Source setups. It adds no other public `vite-hub/*/vite` paths or provider-specific app aliases. Use `vitehub()` to set up the framework, and the package paths above for advanced control.

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)

`@vite-hub/agent/server/github` also exports `createGitHubRequiredCheckPolicyReader` and `evaluateGitHubRequiredChecks`. They read active rulesets and classic required-check protection, keep App bindings, and classify the full check results for an exact head commit. An unknown policy is not the same as a known policy with no required checks. Use cached results for scheduling and inspection, not to allow a merge. Reset the policy reader after branch-protection or ruleset changes.
