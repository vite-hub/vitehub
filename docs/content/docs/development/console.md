---
title: Console
description: Enable the read-only Console, navigate configured primitives, and protect its routes.
navigation.order: 32
icon: i-lucide-monitor-dot
---

The ViteHub Console is a read-only app for inspecting the primitives enabled in the same ViteHub configuration. It is off by default. Enable it, start the app, then open `/_vitehub` to choose a section.

The Console currently exposes Agents, Blob, Database, KV, Rate Limit, Workflow, Queue, and Schedule. The home shows only configured primitives in a grid and places the last opened primitive first, with that preference stored in the browser. Opening a section replaces the sidebar items with that section's navigation, and **All sections** returns to the Console home. **Search console** opens a command palette with the active primitive pages plus Agents and retained sessions when Agents is enabled. Blob lists configured stores and bounded pages of object metadata without downloading contents or exposing provider URLs. Database lists discovered Definitions, their source metadata, definition mode, and statically discovered table names without connecting to a database. KV lists configured stores and keys, then fetches a value only after the key is selected. Rate Limit lists statically discovered policies and source locations without reading live counters. Workflow, Queue, and Schedule list discovered Definitions and their source metadata without loading the Definition modules. Static Schedule Definitions also show their cron expression and UTC time zone; runtime targets show whether runtime Schedules are allowed.

Console data can contain user prompts, model output, tool activity, Blob metadata, provider metadata, and stored KV values. Protect the Console before making it reachable on a production URL.

## Enable the Console

Set `console: true` in the root ViteHub integration during development. Production builds require an explicit access contract described below.

```ts [vite.config.ts]
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vitehub({
    agent: true,
    blob: true,
    console: true,
    preset: 'node',
    kv: true,
    queue: true,
    schedule: true,
    workflow: true,
  })],
})
```

A standalone Nitro 3 app adds Nitro after ViteHub. The Console app and its UI dependencies ship inside `vite-hub`, so an existing Nitro app does not need another Console or UI package.

```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vitehub({
      agent: true,
      console: true,
      preset: 'node',
    }),
    nitro(),
  ],
})
```

Nuxt uses the same option. Install Nuxt UI because the Console uses the ViteHub UI module.

```bash [Terminal]
pnpm add @nuxt/ui
```

```ts [nuxt.config.ts]
import viteHubNuxt from 'vite-hub/nuxt'

export default defineNuxtConfig({
  modules: [
    [viteHubNuxt, {
      agent: true,
      console: true,
      preset: 'node',
    }],
  ],
})
```

Restart the development server after changing the option. Open `http://localhost:3000/_vitehub`, using your app's actual origin and port.

If `console` is omitted or set to `false`, ViteHub does not register a Console page, API handler, Nitro plugin, or public asset path. A disabled Console returns the host's normal not-found response.

## Protect both route groups

The Console registers the page under `/_vitehub/**` and its read API under `/api/_vitehub/console/**`. A production build rejects bare `console: true` so these inspection routes cannot be exposed accidentally.

If the app uses ViteHub Auth, set `console: { access: 'auth' }` and guard both route groups in the Primary Auth Definition. The host decides what makes a user an administrator.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    auth: true,
    console: { access: 'auth' },
    preset: 'node',
  })],
})
```

```ts [server/auth.ts]
import { defineAuth, type AuthAccessAuthorize } from 'vite-hub/auth'

const authorizeConsole: AuthAccessAuthorize = ({ user }) =>
  user.role === 'admin'

export default defineAuth({
  access: {
    routes: [
      { route: '/_vitehub/**', authorize: authorizeConsole },
      { route: '/api/_vitehub/console/**', authorize: authorizeConsole },
    ],
  },
})
```

ViteHub checks for an Auth Session before it calls `authorizeConsole`. A missing session returns `401`. Returning `false` from the callback returns `403`. The callback can return a `Response` when the app needs another rejection or redirect.

The `role` field above is an application example, not a ViteHub field. Replace it with the role, permission, or allowlist already used by the host.

Apps that use another authentication library must protect both route groups in host middleware and acknowledge that boundary explicitly:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: { exposure: 'host-managed' },
    preset: 'node',
  })],
})
```

`host-managed` is an acknowledgement, not middleware. ViteHub does not inspect or enforce the host's access policy in this mode.

Read [Auth](/docs/server-primitives/auth#authorize-access-routes) for sign-in redirects and the complete callback contract.

## Know what the Console stores

When Agents are configured, the Console installs a fallback Agent Invocation journal at `.vitehub/data/console.sqlite`. It retains invocation records and selected searchable text, including prompts, messages, final text, and progress updates. A KV-only Console does not install the Agent journal or Agent read endpoints.

Set `VITEHUB_CONSOLE_DATABASE_URL` when the journal belongs on another volume or libSQL endpoint. Relative `file:` paths resolve from the ViteHub project root:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=file:/var/lib/my-app/console.sqlite
```

Authenticated libSQL endpoints also require `VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN`:

```dotenv [.env]
VITEHUB_CONSOLE_DATABASE_URL=libsql://my-database.turso.io
VITEHUB_CONSOLE_DATABASE_AUTH_TOKEN=secret-token
```

The journal has no automatic TTL or deletion. In production, the operator must define how long to retain the file and how to remove records that may contain sensitive data. Workflow, Queue, and Schedule Definition inspection do not use the journal. Workflow and Queue do not expose run or message history because ViteHub does not yet have provider-independent contracts for listing that operational data. The Schedule page is a build-time Definition catalog; it does not include runtime-created Schedule records or their run store yet.

The fallback applies only when an Agent Definition does not configure `invocations`. An explicit `defineAgent({ invocations })` store remains authoritative, and its sessions are not copied into `console.sqlite` or read by the built-in Console.

The automatic fallback also requires `defineAgent` from `vite-hub/agent`. Definitions imported directly from `@vite-hub/agent` must configure their own `invocations` store. Use the [Invocation UI](/docs/ui/invocation) with that store when the app needs a custom inspection page.

Production Console builds with Agents currently require `preset: 'node'` because the fallback journal uses local SQLite. The Node preset supports the build, but it does not make `.vitehub/data/console.sqlite` persistent: the host must provide durable storage that survives process and deployment replacement. The file is also local to one replica and is not shared across replicas. Other presets can run the Agent Console during development. Their production builds fail while Agents are exposed in the Console, so ViteHub does not write the journal to storage that may disappear between requests or deployments. A KV-only Console does not have this storage restriction.

The Console API accepts `GET` requests only. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

KV inspection calls the configured store's `keys`, `get`, and `has` operations. It never calls `set`, `del`, or `clear`. The key list returns at most 200 entries and reports when more keys match, so use the prefix field to narrow a large store. Selected values are rendered as text or formatted JSON and truncated at 256 KiB in the response. Listing and reading can still count as provider operations even though they do not change data.

Blob inspection calls only the configured store's `list` operation. It returns at most 100 objects initially and 250 per request, follows provider cursors only when you choose **Load more**, and supports a pathname prefix. It does not call `get`, `head`, `serve`, `sign`, `put`, or `del`. Object contents and provider URLs never enter the Console response. Listing can still incur provider requests and cost.

## Inspect usage

Session details show recorded token totals when the invocation trace contains provider usage. Add the [Usage Capability](/docs/capabilities/usage) when the provider needs an explicit usage request or the Agent must expose the normalized Agent Usage Record at finish.

The Console does not calculate missing provider data. Token counts, model metadata, and provider-reported cost remain absent when the provider does not report them.

## Fix common failures

| Symptom | Check |
| --- | --- |
| `/_vitehub` returns `404` | Confirm `console: true`, then restart the development server. Omitted and false configurations register no route. |
| Agents is absent from the Console home | Configure `agent`. The Console only lists primitives active in the same ViteHub configuration. |
| KV is absent from the Console home | Configure `kv`. The Console only lists stores from the active KV configuration. |
| Blob is absent from the Console home | Configure `blob` with a preset that supports Blob or an explicit Blob store. |
| Blob inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to list the configured store. |
| Databases is absent from the Console home | Configure `database`. The Console catalogs Database Definitions only when the integration is enabled. |
| Rate Limits is absent from the Console home | Configure `rateLimit` and use statically declared `requireRateLimit()` policies. |
| A KV key list stops at 200 entries | Enter a key prefix to narrow the list. The Console reports the total returned by the provider and does not fetch values until selection. |
| KV inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to read the configured store. Read-only Console requests still perform provider reads. |
| Agents opens but has no sessions | Invoke a discovered Agent. Confirm it uses the framework fallback instead of a separate `invocations` store. |
| A production build rejects `console: true` | Configure an explicit production access contract: use `console: { access: 'auth' }` with callback-backed policies for both route groups, or acknowledge host middleware with `console: { exposure: 'host-managed' }`. The Node preset is required only while Agents are exposed; a KV-only Console may use another supported preset. |
| The page returns `401` | Sign in through the Auth provider configured by the host. |
| The page returns `403` | Check the host's `authorize` callback and the current user's role or permission. |

Use [Agent Invocations](/docs/agents/invocations) for custom stores and invocation lifecycle behavior. Use [Invocation UI](/docs/ui/invocation) when building an application-owned inspection page instead of mounting the complete Console.
