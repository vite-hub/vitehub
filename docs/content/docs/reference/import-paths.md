---
title: Import paths
description: Which ViteHub imports are stable, and which paths are generated or internal.
navigation.order: 51
navigation.group: Setup
icon: i-lucide-route
---

Stable import paths are the ViteHub imports your app may use. Behind them can be registries, generated files, virtual modules, or package code. Do not depend on what is behind them.

## Canonical application imports

Applications that install `vite-hub` use the root only for framework
composition and explicit feature subpaths for application APIs.
Each feature subpath, such as `vite-hub/agent`, re-exports the matching owner
path, such as `@vite-hub/agent`, unchanged. Both paths give the same values and
the same behavior.

| Import path | Use |
| --- | --- |
| `vite-hub` | `vitehub()`, the framework Vite plugin. |
| `vite-hub` | `detectHost()`: the host `vitehub()` detects when `host` is omitted. Use it for host-specific config. |
| `vite-hub/skills` | Define and serve [Agent Skills](/docs/development/skills) through HTTP discovery and MCP. |
| `vite-hub/agent/vite` | Process Agent host and generated health and Workspace routes for Vite. |
| `vite-hub/agent` | Agent Definition, invocation, trigger, and Agent Invoker APIs. |
| `vite-hub/agent/capabilities` | Official Capability factories. |
| `vite-hub/agent/channels` | Official Channel Kind helpers. |
| `vite-hub/agent/eval` | Agent Eval helpers. Install Evalite and the test runner yourself. |
| `vite-hub/agent/observability` | `useObservability()` for the instance configured by `vitehub({ observability })`. |
| `vite-hub/logs` | The LogSource contract and `createLogBuffer()`. Import the Evlog logger API from `evlog`. |
| `vite-hub/logs/source` | Server-side LogSource contract, query validation, and cursor errors without Evlog. |
| `vite-hub/logs/memory` | Bounded local buffer for an existing redacted drain. Runs without Evlog, but its types need `evlog`. |
| `vite-hub/logs/host` | Install and resolve a project's LogSource in the process-wide registry, without Evlog. |
| `vite-hub/agent/cloudflare` | Cloudflare Agent state helpers. |
| `vite-hub/agent/vue` | Vue Agent client handle and AI SDK chat composable. |
| `vite-hub/agent/server` | Manual server integration. |
| `vite-hub/agent/state` | SQLite and libSQL-compatible durable Agent state. |
| `vite-hub/agent/process` | Long-running Node process hosts: preset process hosts, the self-hosted process host, and adaptive process capacity. |
| `vite-hub/decisions` | [`defineChoices()`](/docs/decisions/server-api): text becomes choices over options that you declare. Re-exports `@vite-hub/decisions`. |
| `vite-hub/decisions/vue` | [`useChoices()`](/docs/decisions/client): Vue selection state, optional debounce, and cancellation for a resolver you provide. Re-exports `@vite-hub/decisions/vue`; auto-imported in Nuxt. |
| `vite-hub/forms` | `defineForm()` for `server/forms/<name>.ts`: a form that visitors send to the site owner. Re-exports `@vite-hub/forms`. |
| `vite-hub/forms/client` | `submitForm()`: posts the values of a form to its route and returns the issue of each field. Re-exports `@vite-hub/forms/client`. |
| `vite-hub/forms/database` | The `vitehub_form_submissions` table and `createDrizzleFormsStore()`. Re-exports `@vite-hub/forms/database`. |
| `vite-hub/forms/operations` | The `forms.list`, `forms.get`, and `forms.mark` operations of the Console, `vitehub forms`, and MCP. Re-exports `@vite-hub/forms/operations`. |
| `vite-hub/forms/runtime` | `installedForms()`: the inbox of the running app, for server code. Re-exports `@vite-hub/forms/runtime`. |
| `vite-hub/forms/vue` | `AutoForm`, a whole form from a Valibot object schema, and `useFormSubmit()` for a Formisch form. Needs `@formisch/vue`. Re-exports `@vite-hub/forms/vue`; `useFormSubmit()` is auto-imported in Nuxt. |
| `vite-hub/i18n` | [`t`, `plural`, `select`, `selectOrdinal`, `msg`](/docs/i18n/server-api), `getLocale()`, `getLocales()`, `setLocale()`, and `translate()`. Messages in the source language, compiled to IDs by the build. Re-exports `@vite-hub/i18n`. |
| `vite-hub/i18n/vue` | [`createI18n()`](/docs/i18n/configure#add-i18n-to-a-vue-app) and `useLocale()` for Vue apps. Re-exports `@vite-hub/i18n/vue`; `vite-hub/nuxt` installs the plugin and auto-imports `useLocale()`. |
| `vite-hub/i18n/runtime` and `vite-hub/i18n/server` | The i18n runtime and the Nitro request scope that the generated i18n code imports. Apps do not import them. |
| `vite-hub/gateways` | [AI Gateways](/docs/gateways): routes for Codex and Claude Code model requests, and `ask()` for TypeSafe Jev questions. Re-exports `@vite-hub/gateways`. |
| `vite-hub/gateways/ai-sdk` | [`languageModel()`](/docs/gateways/server-api#use-a-model-with-the-ai-sdk): an AI SDK model that sends requests through a gateway. Re-exports `@vite-hub/gateways/ai-sdk`. |
| `vite-hub/presets/babysitter` | Composable Babysitter repair-loop preset. |
| `vite-hub/presets/babysitter/server` | Babysitter host runtime integration. |
| `vite-hub/presets/labeller` | Gmail labelling preset with ordered rules, Jev fallback, and allowlisted message actions. |
| `vite-hub/presets/workspace` | Opt-in workspace source-provenance citation preset. |
| `vite-hub/agent/invocations` | Durable Agent Invocation stores: Cloudflare D1 with its schema statements, and libSQL-compatible SQLite. |
| `vite-hub/agent/invocations/database` | Agent Invocation Journal backed by a ViteHub SQLite database. |
| `vite-hub/agent/invocations/drizzle` | `getAgentInvocationsDatabase()`: Drizzle over the default Agent Invocation journal. Needs `drizzle-orm`. |
| `vite-hub/agent/mcp` | MCP Server configuration helpers. |
| `vite-hub/console` | Route metadata for the local read-only invocation console. |
| `vite-hub/console/auth` | `defineConsoleAuthorize()` for `console.authorize`, and its context types. |
| `vite-hub/console/mcp-client` | Console MCP client operations. The generated Console plugin installs them when `console.mcpClient` is on. |
| `vite-hub/console/server` | Local Console invocation journal for servers. |
| `vite-hub/console/ui` | Agent Invocation views from the Console: `AgentInvocation`, `AgentInvocationList`, and `AgentCapabilityInspector`. Install `@vite-hub/ui @json-render/core @json-render/vue @vueuse/core` first. |
| `vite-hub/content`, `vite-hub/content/client`, `vite-hub/content/database`, `vite-hub/content/editor`, and `vite-hub/content/realtime` | Comark Content definition and every field helper (`image()`, `file()`, `seo()`, `optional()`), Source adaptation, generated runtime handler, typed client, editor codecs, realtime collaboration, and the sessions table schema. |
| `vite-hub/content/collections` | Editable document collections (`documents()`, `singleton()`). Needs `@vite-hub/workspace`. |
| `vite-hub/content/markdown` | Markdown negotiation middleware and Markdown 404 helpers. Pass a Content runtime or a loader that defers Content until a Markdown request. |
| `vite-hub/content/preview` | The Content preview API and `defineContentPreviewPlugin()`. Pass a runtime or a loader. A loader defers Content until the first preview request. |
| `vite-hub/content/sqlite` | In-memory SQLite database for full-text search on Node and Cloudflare Workers. |
| `vite-hub/cms` | The `cms` preset that stores document collections on a contributed Workspace. |
| `vite-hub/cms/access` | The CMS roles for the Better Auth `admin` plugin, `admin(cmsAccess)`, and the policies from those roles: `cmsCan()`, `cmsContentAuthorize`, `cmsCommentsAuthorize`, and `cmsConsoleAuthorize`. |
| `vite-hub/cms/vite` | `hubCms()`, the Vite plugin that adds the `cms` preset's Workspace, its tables, and a Database when the app has none. `vitehub()` registers it. |
| `vite-hub/docs/nuxt` | The Nuxt module of a [docs site](/docs/docs-site): pages from a Markdown folder, the docs shell and theme, search, and agent resources. Re-exports `@vite-hub/docs/nuxt`. |
| `vite-hub/docs` | Docs site frontmatter schema, manifest types, and navigation helpers. Re-exports `@vite-hub/docs`. |
| `vite-hub/docs/assistant` | `docsAssistant`, the Agent preset that answers reader questions from the docs, and `docsRateLimit()`. Re-exports `@vite-hub/docs/assistant`. |
| `vite-hub/auth` and `vite-hub/auth/server` | Auth Definitions and server runtime helpers. |
| `vite-hub/auth/abilities` | [`defineAbilities()`, `guest()`, and `deny()`](/docs/auth/abilities) for permission rules shared by server and app. |
| `vite-hub/auth/mcp` | OAuth sign-in, discovery, request checks, and unused-client cleanup for an app's MCP server. Needs `@better-auth/oauth-provider`. |
| `vite-hub/auth/database` | `authDatabase()` connects Better Auth to an app Database and adds its tables to generated migrations. |
| `vite-hub/auth/schema` | `authSqliteSchema` and `authPostgresSchema`, the Better Auth tables for SQLite and Postgres. |
| `vite-hub/auth/presets` | Auth presets, such as `stateless()` for sessions without a database. |
| `vite-hub/auth/agent` | Better Auth session mapping into Agent Invokers. |
| `vite-hub/auth/vue` | Better Auth Vue client, normalized session composables, `useAbility()`, and the `Can` and `Cannot` components. |
| `vite-hub/blob` | Blob Runtime Helpers, Blob Store access, `ensureBlob()`, `detectContentType()`, and the `image()` and `file()` Blob reference schemas. |
| `vite-hub/blob/client` | Framework-neutral browser upload helpers: `uploadFiles()`, `createMultipartUploader()`, and `detectContentType()`. |
| `vite-hub/blob/media` | Browser-safe media helpers: `responsiveImage()`, `imageVariantUrl()`, `parseImageVariant()`, and `probeImage()`. |
| `vite-hub/blob/vue` | Vue upload composables: `useUpload()` and `useMultipartUpload()`. |
| `vite-hub/browser` | Browser Definitions, invocation-scoped Playwright sessions, named Browser runs, and Browser Run actions (`runBrowserAction()`, `runBrowserContent()`). |
| `vite-hub/web-container` | Boot and mount a [WebContainer](/docs/web-container) in the browser, run app commands, read preview readiness and status, and export snapshots. Re-exports `@vite-hub/web-container`. |
| `vite-hub/web-container/connect` | Static connection-provider metadata and credential-to-process environment mapping with [`defineConnect()` and `connectEnv()`](/docs/web-container/configure#describe-connectable-accounts). Re-exports `@vite-hub/web-container/connect`. |
| `vite-hub/browser/controllers/cdp` and `vite-hub/browser/controllers/playwright` | Advanced raw CDP and Playwright Browser Session controllers. |
| `vite-hub/browser/providers/cloudflare` and `vite-hub/browser/providers/local` | Advanced explicit provider selection for low-level Browser Clients. |
| `vite-hub/bundle` | Read the [bundle report](/docs/bundle) of the last build: `readBundleReport()` and `explainBundleTarget()`. Re-exports `@vite-hub/bundle`. |
| `vite-hub/channels` and `vite-hub/channels/server` | Channels with `defineChannel()`, the `webhook()` and `stripe()` adapters, and `useChannel()` for named sends. |
| `vite-hub/comments` | `defineComments()` for `server/comments.ts`, as the `comments` export or the default export. One definition runs the overlay, Comments API, presence, MCP, and [comment operations](/docs/comments/operations/get-started). |
| `vite-hub/comments/anchor`, `vite-hub/comments/database`, and `vite-hub/comments/runtime` | Browser pin anchors, the Comments tables, and the API handler and Nitro plugin that generated output imports. |
| `vite-hub/comments/client`, `vite-hub/comments/rpc`, `vite-hub/comments/server`, and `vite-hub/comments/database/postgres` | The operations browser client and anchors, RPC transport, server runtime, and Postgres tables. |
| `vite-hub/page/pill.js` | The page pill of ViteHub's page tools as a classic browser script that declares `ViteHubPagePill`, for a page script of your own to paste in as text, for example with a Vite `?raw` import. It has no module exports. |
| `vite-hub/connections`, `vite-hub/connections/google`, and `vite-hub/connections/server` | Connection Definitions and `createConnectionsHandler()` (the management and OAuth routes that `connections.management` mounts), the Google preset with typed Gmail Operations, and runtime access. |
| `vite-hub/connections/chatgpt` | The `chatgpt()` Connection provider for signing in with a ChatGPT plan. |
| `vite-hub/sandbox` | Sandbox Definitions and built-in runtime selection for trusted-host, Crabbox, Cloudflare Sandbox, and Vercel Sandbox execution. |
| `vite-hub/sandbox/ssh` | `sshLaunch` for provider Driver launch callbacks and `serveSsh` for a trusted SSH runner. |
| `vite-hub/database` | Database Definitions and generated `useDatabase()` access. |
| `vite-hub/env` | Env Declaration helpers, presets, `defineEnvProvider()`, purpose-bound `seal()` and `unseal()`, `parseSchema()`, `SecretEnv`, and generated Env access (`useServerEnv()`, `usePublicEnv()`, `loadServerEnv()`, `deriveSecret()`). |
| `vite-hub/env/server` | Resolve, load, describe, or inspect an explicit Server Env registry. |
| `vite-hub/env/bridge` | Runtime credential replacement, scoped grants, durable activity, the authentication adapter `createEnvAuthenticator()`, and the management handler `createEnvBridgeHandler()`. |
| `vite-hub/env/database` | Encrypted Env Bridge storage on ViteHub SQLite/Drizzle databases. A separate entry because it loads the optional `drizzle-orm` peer. |
| `vite-hub/email` and `vite-hub/email/markdown` | Email clients, configured runtime delivery, and Dynamic Markdown HTML with a composed Markdown text fallback. |
| `vite-hub/email/test` | `createTestEmail()`: in-memory message capture for tests. |
| `vite-hub/env/seal` | AES-GCM `sealWithKey`, `unsealWithKey`, `importSealKey`, and `sealKeyId` in the Env Bridge database store format. To seal an app value with `VITEHUB_SECRET`, use `seal` and `unseal` from `vite-hub/env`. |
| `vite-hub/forge` | [Forge](/docs/forge): `useForge()` for GitHub App installation tokens and GitHub, GitLab, and Forgejo clients. Needs `@vite-hub/forge`. |
| `vite-hub/kv` | KV Runtime Helper. |
| `vite-hub/markdown-template` | Portable Markdown rendering from template strings. |
| `vite-hub/markdown-template/file` | Filesystem Markdown rendering from explicit file paths or `file:` URLs. |
| `vite-hub/mcp` | `defineMcpTool()` for the tools of the app's MCP server in `server/mcp/tools/`. Requires `@vite-hub/mcp`. See [MCP server](/docs/mcp). |
| `vite-hub/operations` | `defineOperation()` and its types. See [Operations](/docs/development/operations). |
| `vite-hub/queue` | Queue Definitions and dispatch helpers. |
| `vite-hub/rate-limit` | Rate Limit handles declared in your source, and direct Rate Limiters. |
| `vite-hub/rate-limit/drivers/memory` | `memoryRateLimitDriver()`: fixed windows in one process, for local runs and tests. |
| `vite-hub/rate-limit/drivers/cloudflare` | `cloudflareRateLimitDriver()`: direct access to a Cloudflare Rate Limiting binding. |
| `vite-hub/realtime`, `vite-hub/realtime/server`, and `vite-hub/realtime/vue` | Realtime Definitions, manual server integration, and Vue collaborative editing, saved through [Realtime document adapters](/docs/realtime/server-api#custom-document-adapters). |
| `vite-hub/realtime/bus` | Node room fanout through Postgres or Redis, bus selection, and shutdown hooks for manual server integration. |
| `vite-hub/realtime/client` | `connectRealtimeRoom()`: presence in one room without an editor or Vue. |
| `vite-hub/runtime` | `getHostBinding()` for raw host bindings, `detectHost()` for host-specific config, Runtime Host Context, `getRuntimeContext()` and `getStandardContext()` for a Fetchable `Request`, policy, approval, trace, and capability APIs. |
| `vite-hub/runtime/durability` | `getDurabilityReport()` and the `Durability` type: where each primitive of a Node server keeps its state. See [Durability and instances](/docs/frameworks-hosts/node-self-hosted#durability-and-instances). |
| `vite-hub/sandbox/task` | Sandbox Task Definitions and `runSandboxTask()`. |
| `vite-hub/schedule` | Static Schedule Definitions and `runSchedule()`. |
| `vite-hub/schedule/runtime` | Schedule Run stores and custom runtime wiring. |
| `vite-hub/schedule/runtime/process` | Process Runtime that runs Static Schedules in a long-lived Node process. |
| `vite-hub/schedule/runtime/kv` | ViteHub KV storage adapter for Schedule Runs. |
| `vite-hub/shell` | Shell runtime and command analysis APIs. |
| `vite-hub/shell/providers/just-bash` | Just Bash Shell provider. |
| `vite-hub/shell/workspace` | Workspace-backed Shell execution helpers. |
| `vite-hub/test` | `setupViteHubTest()` for app tests: local backends for KV, Blob, Database, Queue, Email, and Rate Limit, Server Env values, and Channel deliveries. See [Testing](/docs/development/testing). |
| `vite-hub/source` | Runtime-neutral Source Definitions, custom loaders, registry APIs, Collections (`defineCollection`, `array`), and the built-in loaders `file()`, `files()`, `glob()`, `markdown()`, and `github()`. `files()` is the Source that `glob()` becomes in a server build. |
| `vite-hub/source/drizzle` | `table()`, a Collection over a Drizzle table. Needs `drizzle-orm`. |
| `vite-hub/source/client` and `vite-hub/source/server` | Vue Collection pagination and the H3 Collection route adapter. |
| `vite-hub/source/mcp` | MCP Resources implementation. Needs `@modelcontextprotocol/sdk`. |
| `vite-hub/source/vite` | Source discovery, generated artifacts, and Nitro route integration for custom Vite plugin composition. |
| `vite-hub/ui`, `vite-hub/ui/headless`, and `vite-hub/ui/styles.css` | Every AI interface component, headless message scrolling, and default styles. |
| `vite-hub/ui/markdown-editor` | `MarkdownEditor` with uploads to Blob. Kept out of the root import, so it loads Tiptap only where you use it. |
| `vite-hub/ui/vite` | Register the canonical UI package for Vue with Vite. In Nuxt, `vite-hub/nuxt` adds the UI runtime. |
| `vite-hub/tsconfig` | TypeScript config that includes ViteHub's generated declaration entry without taking ownership of application source includes. |
| `vite-hub/workflow` | Workflow Definitions and run helpers. |
| `vite-hub/workflow/openworkflow` | `startOpenWorkflowWorker()` and `createOpenWorkflowWorker()` for a long-lived OpenWorkflow worker process. Install `openworkflow`. |
| `vite-hub/workspace` and `vite-hub/workspace/runtime` | Workspace Definitions, Sources, history contracts, runtime facades, and registry APIs. |
| `vite-hub/workspace/files` | `useWorkspaceFiles()` for file and history access without constructing Agent tools. |
| `vite-hub/workspace/checkout` | `vitehub pull` and `vitehub push` as functions, and `localCheckoutStatus()`, which `vitehub status` shows. Node only. |
| `vite-hub/workspace/lineage` | `derivedFrom` helpers: `lineageDigest()`, `readDerivedFrom()`, and `staleDerivedFiles()`. |
| `vite-hub/workspace/cloudflare` | Cloudflare Workspace runtime setup. |
| `vite-hub/workspace/blob-database` | Content-addressed Workspace history Store and Database schema. Requires `drizzle-orm`. |
| `vite-hub/workspace/loader` and `vite-hub/workspace/server` | Workspace loader and manual server extension APIs. |

ViteHub adapters use `vite-hub/*` imports. You install their optional third-party providers and SDKs yourself. Provider Output, build plugins, and provider modules not listed here stay in their own packages.

## Owner-package imports

Each `vite-hub/<path>` above re-exports the owner path `@vite-hub/<path>`. Apps import the `vite-hub` path, and Doctor rule [`VHUB0036`](/docs/reference/doctor-rules#vhub0036) reports an owner path in an app. You can install each owner package on its own, for libraries and integrations that do not use `vite-hub`.

These paths have no `vite-hub` path:

| Import path | Owner | Use |
| --- | --- | --- |
| `@vite-hub/agent/observability/host` | Agent Package | `installObservability()` for hosts without `vitehub()`. |
| `@vite-hub/agent/observability/posthog` | Agent Package | Optional PostHog exporter. |
| `@vite-hub/agent/test` | Agent Package | Agent test runner helpers for local and CI Agent Invocation checks. |
| `@vite-hub/docs/navigation` | Docs Package | The manifest types and navigation helpers. |
| `@vite-hub/docs/server` | Docs Package | `createDocsManifest()`, the Markdown parser, and `toRawMarkdown()`, for tools and tests that read a content folder without Nuxt. |
| `@vite-hub/docs/primitive-rail` | Docs Package | `PrimitiveRail`, the navigation rail for Server Primitives. |
| `@vite-hub/cli` | CLI Package | The `vitehub` command and its programmatic CLI entry. Use the `vite-hub` distribution for application integration. |
| `#vitehub/emails/<name>` | Email Package | Generated async renderer for a discovered `server/emails/**/*.md` template. |
| `#vitehub/env/public` | Env Package | Generated Public Env access for browser code. Server code imports `usePublicEnv()` from `vite-hub/env`. |
| `@vite-hub/ui/workspace` | UI Package | The WebContainer workspace parts and `PlaygroundContainer`, outside the root so a chat page never loads CodeMirror or xterm. |
| `@vite-hub/ui/playground` | UI Package | Share links and zips for a playground, with no UI. They run in Node too. |
| `@vite-hub/ui/theme` and `@vite-hub/ui/theme.css` | UI Package | `vitehubTheme`, the Nuxt UI app config, and the design tokens and focus ring. |
| `@vite-hub/web-container/vue` | WebContainer Package | `useWebContainer()`, the Vue composable for the WebContainer lifecycle, files, commands, and preview. |
| `#vitehub/schedule/registry` | Schedule Package | Generated static schedule registry for host bridges. |

## Integration imports

| Import path | Use |
| --- | --- |
| `vite-hub` | The app import for `vitehub()`. |
| `vite-hub/nuxt` | The Nuxt module. It passes the Vite plugin config to Nitro. |
| `vite-hub/doctor` | ViteHub [Doctor rules](/docs/reference/doctor-rules) for Vite Doctor. `vitehub()` and `vite-hub/nuxt` register it. |
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
| `@vite-hub/kv/vite` | The KV Vite plugin. |
| `@vite-hub/queue/vite` | The Queue Vite plugin. |
| `@vite-hub/rate-limit/vite` | Rate Limit source collection and Provider Output. |
| `@vite-hub/realtime/vite` | Realtime discovery and generated runtime wiring. |
| `@vite-hub/sandbox/task/vite` | The Sandbox Task Vite plugin. |
| `@vite-hub/schedule/vite` | The Schedule Vite plugin. |
| `@vite-hub/workflow/vite` | The Workflow Vite plugin. |
| `@vite-hub/workspace/vite` | The Workspace Vite plugin. |

## Generated and internal paths

| Path family | Status | Guidance |
| --- | --- | --- |
| `.vitehub/**` | Generated | Inspect in dev. Do not import these files. |
| `.vercel/output/**` | Generated Provider Output | Deploy or inspect as Vercel Build Output. |
| `.netlify/v1/**` | Generated Provider Output | Deploy or inspect as Netlify function output. |
| `dist/**/wrangler.json` | Generated Provider Output | Deploy or inspect as Cloudflare output. |
| Vite virtual module ids with `\0` prefixes | Internal | Never import directly. |
| `@vite-hub/internal/*` | Internal | Package implementation only. |

There is no `@vite-hub/agent/netlify` import. Netlify Agent output is generated Provider Output in `.netlify/v1`, plus the `.vitehub/agent/netlify-function.mjs` wrapper. With Nuxt, the wrapper is at `<buildDir>/vitehub/agent/netlify-function.mjs` (usually `.nuxt/vitehub/agent/netlify-function.mjs`).

`vite-hub` adds `vite-hub/source/vite` for custom Source setups. It adds no other public `vite-hub/*/vite` paths or provider-specific app aliases. Use `vitehub()` to set up the framework, and the package paths above for advanced control.

## Related

- [Generated files](/docs/development/generated-files)
- [File conventions](/docs/reference/file-conventions)
- [Package reference](/docs/reference)
- [Runtime and host support](/docs/frameworks-hosts/support-matrix)
