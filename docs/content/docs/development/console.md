---
title: Console
description: Enable the Console, inspect configured primitives, and protect its routes.
navigation.order: 32
navigation.group: Local tools
icon: i-lucide-monitor-dot
---

The ViteHub Console inspects the primitives enabled in the same ViteHub configuration. It is off by default. Enable it, start the app, then open `/_vitehub` to choose a section.

ViteHub renders the Console UI and serves its static assets. Each Console operation is one stateless JSON `POST` request, so the same interface works in development and on hosts that route consecutive requests to different instances, such as Cloudflare Workers. The Console does not expose separate resource routes.

The Console currently exposes Env, Agents, Blob, Database, KV, Rate Limit, Sandbox, Workspace, Workflow, Queue, and Schedule. The home shows only configured primitives in a grid and places the last opened primitive first, with that preference stored in the browser. Opening a section replaces the sidebar items with that section's navigation, and **All sections** returns to the Console home. **Search console** opens a command palette with the active primitive pages plus Agents and retained sessions when Agents is enabled. Blob lists configured stores and bounded pages of object metadata without downloading contents or exposing provider URLs. Database lists discovered Definitions, their source metadata, definition mode, and statically discovered table names without connecting to a database. KV lists configured stores and keys, then fetches a value only after the key is selected. Rate Limit lists statically discovered policies and source locations without reading live counters. Sandbox lists discovered Definitions without starting runtime resources. Workspace lists discovered Definitions and source roots without initializing workspace stores, Sources, files, or processes. Workflow, Queue, and Schedule list discovered Definitions and their source metadata without loading the Definition modules. Static Schedule Definitions also show their cron expression and UTC time zone; runtime targets show whether runtime Schedules are allowed.

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
    preset: 'cloudflare',
    kv: true,
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

Nuxt uses the same option. Install Nuxt UI because the Console uses the ViteHub UI module. Install the Lucide and Phosphor icon collections so `@nuxt/icon` can bundle the Console icons.

```bash [Terminal]
pnpm add @nuxt/ui @iconify-json/lucide @iconify-json/ph
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

`@nuxt/icon` does not scan dependencies. The Nuxt module adds every icon that the Console and ViteHub UI use to the `@nuxt/icon` client bundle through the `icon:clientBundleIcons` hook, so the Console does not fetch icons at runtime on edge presets. Do not add `icon.clientBundle.scan` entries for `node_modules/vite-hub`.

If `console` is omitted or set to `false`, ViteHub does not register a Console page, RPC endpoint, Nitro plugin, or public asset path. A disabled Console returns the host's normal not-found response.

## Inspect environment declarations

Open Env to search declared Server Env variables and filter by source. Select a variable to inspect its provider, secret flag, requirement, and whether a default is configured. Host environment includes process environment variables and host runtime bindings.

This view does not read secret values, call external providers, or check credential validity. It does not enumerate undeclared host variables. Values and defaults remain hidden. Update host values through the deployment configuration and provider values in their connected store. Set `env: false` in ViteHub options to disable Env and its Console section.

## Develop against a fixture

Use `vitehub console dev` when Console work needs the same Agent Invocations on every restart. The command validates a versioned JSON fixture, then starts the development command after `--` with an in-memory Console journal. It does not write `.vitehub/data/console.sqlite`.

```bash [Terminal]
pnpm vitehub console dev \
  --fixture test/fixtures/console.fixture.json \
  -- pnpm dev
```

Fixture paths resolve from the Vite project root. Put records in oldest-to-newest order so the generated journal cursors produce the expected newest-first session list. A version 1 fixture contains complete `AgentInvocationRecord` values. `cursor` is optional because fixture mode assigns one from the array order.

```json [test/fixtures/console.fixture.json]
{
  "version": 1,
  "invocations": [
    {
      "id": "fixture_support_reply",
      "traceId": "fixture_trace_support",
      "agentName": "support",
      "status": "completed",
      "createdAt": "2026-08-27T10:00:00.000Z",
      "updatedAt": "2026-08-27T10:00:02.000Z",
      "completedAt": "2026-08-27T10:00:02.000Z",
      "observations": [
        {
          "name": "agent.message",
          "type": "run",
          "sequence": 1,
          "timestamp": "2026-08-27T10:00:01.000Z",
          "attributes": {
            "message.role": "assistant",
            "message.content": "Your fixture is ready."
          }
        }
      ]
    }
  ]
}
```

The wrapper preserves the child command's exit status, translating signal termination to the conventional `128 + signal number` status. Invalid arguments, unreadable files, malformed JSON, unsupported fixture versions, duplicate invocation ids, and invalid records print a diagnostic to stderr and return status `1` without starting the development command. Fixture mode is development-only, and a production build rejects the fixture environment before it generates server output.

Fixtures often contain prompts and model output. Use synthetic or scrubbed records before committing them.

## Protect the Console route

The Console registers its page, assets, and RPC endpoint under `/_vitehub/**`. The RPC endpoint is `POST /_vitehub/rpc/__call`. The Console access policy checks each call, so a session cookie authorizes every request on its own. Provider status also uses `GET /api/_vitehub/console/status`; the other previous resource handlers are not registered. A production build rejects bare `console: true` so this inspection interface cannot be exposed by accident.

ViteHub sends `X-Robots-Tag: noindex, nofollow` on the Console route and includes the equivalent robots meta tag in the standalone Console page. These directives keep the Console out of search engines that honor them. They do not restrict access, so keep the production access policy below.

Console Auth can use its own Better Auth session. It does not require the application's Primary Auth Definition. For a Node host, the inline GitHub setup accepts only verified email addresses in `allowedEmails`:

If you previously protected the Console through Primary Auth, remove its `/_vitehub/**` and `/api/_vitehub/console/**` access routes when you switch to `console.auth`. Keep `auth: true` if application routes still use Primary Auth. Otherwise, both auth guards apply and maintainers must sign in twice.

Inline Console Auth uses `node:sqlite` and requires the Node deployment preset. Other presets need a file-based Console Auth Definition with a database adapter supported by the host.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: {
      access: 'auth',
      auth: {
        provider: 'github',
        allowedEmails: ['maintainer@example.com'],
        databasePath: '/var/lib/app/console-auth.sqlite',
        baseURL: 'https://agent.example.com',
      },
    },
    preset: 'node',
  })],
})
```

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `BETTER_AUTH_SECRET` in the server environment. `baseURL` is the public origin used for OAuth redirects; set it when a proxy terminates TLS. The GitHub callback URL is `https://agent.example.com/api/_vitehub/console/auth/callback/github`. For Nuxt apps mounted below `/`, ViteHub includes `app.baseURL` in the callback and redirects. Put `databasePath` on persistent storage. Console Auth creates or updates its Better Auth tables before the first protected request. It refuses a missing database or secret. Application requests and channel requests keep their own authentication.

For a custom provider, GitHub organization check, or Better Auth server plugins, commit `vitehub/console/auth/server.ts` and use `console: { access: 'auth', auth: {} }`. The file can import `defineAuth` and export a Console definition:

```ts [vitehub/console/auth/server.ts]
import { DatabaseSync } from 'node:sqlite'
import { defineAuth } from 'vite-hub/auth'
import { defineConsoleAuth } from 'vite-hub/console/auth'

const database = new DatabaseSync('/var/lib/app/console-auth.sqlite')

export default defineConsoleAuth({
  auth: defineAuth(() => ({
    baseURL: process.env.CONSOLE_AUTH_BASE_URL,
    database,
    secret: process.env.BETTER_AUTH_SECRET,
    socialProviders: {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID!,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      },
    },
  })),
  signIn: { provider: 'github' },
  authorize: ({ user }) => user.email === 'maintainer@example.com',
})
```

ViteHub fixes this definition's auth route to `/api/_vitehub/console/auth/**` and its cookie prefix to `vitehub_console`. It guards `/_vitehub/**` and every method under `/api/_vitehub/console/**`, including the RPC transport and invocation actions. An unauthenticated browser visit opens `/_vitehub/sign-in`; the provider redirect starts only after the user selects its sign-in button. Console APIs return 401 without a session. The sign-in page and auth callback are excluded from the guard. The server file must provide a Better Auth database adapter and a secret. The host must place that database on durable storage. ViteHub runs Better Auth migrations before serving the first protected request. Set `migrate: false` only when your own startup process has applied the schema.

An optional `vitehub/console/auth/client.ts` can provide Better Auth client plugins and a `setup` hook. ViteHub bundles it for the Console pages only:

```ts [vitehub/console/auth/client.ts]
import { defineConsoleAuthClient } from 'vite-hub/console/auth/client'

export default defineConsoleAuthClient({
  plugins: [],
  setup(client) {
    // Add Console-only browser behavior here.
  },
})
```

Use `console.auth.server` or `console.auth.client` for a file in another location. An explicit path conflicts with the corresponding discovered file. Client code does not authorize requests.

### Cloudflare Access

Inline Console Auth needs `node:sqlite`, so it cannot run on Workers. On Cloudflare, protect the Console with a [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) self-hosted application instead. ViteHub verifies the token that Access forwards, so the Console needs no sign-in page, database, or secret:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: {
      access: 'auth',
      auth: { provider: 'cloudflare-access' },
    },
    preset: 'cloudflare',
  })],
})
```

Create the Access application for the Console hostname, or at least for `/_vitehub` and `/api/_vitehub/console`. Then set two Worker variables:

- `CF_ACCESS_TEAM_DOMAIN`: the team domain, for example `acme.cloudflareaccess.com`.
- `CF_ACCESS_AUD`: the Application Audience (AUD) tag of the Access application.

The generated middleware guards `/_vitehub/**` and every method under `/api/_vitehub/console/**`. For each request, it reads the `Cf-Access-Jwt-Assertion` header and checks the RS256 signature against `https://<team domain>/cdn-cgi/access/certs`, the issuer, the audience, and the expiry. It keeps the key set in memory for each Worker isolate or server process and fetches it again when the cache expires or a token uses an unknown key. A request without a valid token receives `401`, so a `workers.dev` URL or another route that skips Access stays closed. Missing or invalid settings return `500`.

The Access policy decides who can open the Console. ViteHub accepts every identity that Access admits for this application, including service tokens. The Console shows the Access email, or the service token client ID, on its sign-out button. Sign-out opens `/cdn-cgi/access/logout`.

`teamDomain` and `audience` accept a string or an Env declaration, and default to the two variables above. Values resolve for each request from the process environment or the Worker bindings. `env.provider()` sources are rejected. To list the values on the Console **Env** page, declare them in Server Env and pass the same declarations:

```ts [vite.config.ts]
import { env } from 'vite-hub/env'

const access = {
  teamDomain: env({ source: env.source('CF_ACCESS_TEAM_DOMAIN') }),
  audience: env({ source: env.source('CF_ACCESS_AUD') }),
}

export default defineConfig({
  env: { server: { access } },
  plugins: [vitehub({
    console: { access: 'auth', auth: { provider: 'cloudflare-access', ...access } },
    preset: 'cloudflare',
  })],
})
```

The provider also works on Node and Vercel when Cloudflare proxies the host and Access protects it. During `vite dev` no Access edge exists, so ViteHub does not register the guard. The development server serves the Console without a check, like `console: true`.

Scripts and CLI commands reach Console routes through the same Access application. Cloudflare checks their credentials at its edge and forwards a signed token. The Worker does not read `CF-Access-Client-Id` or `CF-Access-Client-Secret` itself. Create a service token, add a policy with the **Service Auth** action to the application, and send the token headers:

```bash [Terminal]
curl https://agent.example.com/api/_vitehub/console/status \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

`vitehub schedule run --url` forwards these headers when `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` are set in its environment. See [Run a Schedule on demand](/docs/development/cli#run-a-schedule-on-demand).

A tool that can send only an `Authorization` header can use the same service token when the Access application reads service tokens from that header (`read_service_tokens_from_header: "Authorization"`). Send `Authorization: {"cf-access-client-id":"<id>","cf-access-client-secret":"<secret>"}`. A user token from `cloudflared access token -app=https://agent.example.com` also works as the `CF_Authorization` cookie.

### Reuse Primary Auth

Existing applications can instead reuse their Primary Auth Definition. Set `console: { access: 'auth' }` and guard `/_vitehub/**` and `/api/_vitehub/console/**` there:

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

### Host-managed middleware

Apps that use another authentication library must protect `/_vitehub/**` and `/api/_vitehub/console/**` in host middleware and acknowledge that boundary explicitly:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [vitehub({
    agent: true,
    console: { exposure: 'host-managed' },
    preset: 'node',
  })],
})
```

`host-managed` is an acknowledgement, not middleware. ViteHub does not inspect or enforce the host's access policy in this mode. A Cloudflare production build with `host-managed` prints a warning that points to the [Cloudflare Access provider](#cloudflare-access), because the Worker cannot see whether Access protects every Console route.

### Start Agent Invocations

Explicit `access` and `exposure` configurations keep invocation disabled unless you set `invoke: true`. This applies to both Vite and Nuxt:

```ts
console: { exposure: 'host-managed', invoke: true }
// Or use ViteHub Auth:
console: { access: 'auth', invoke: true }
```

For `host-managed`, your middleware must authenticate and authorize all `/_vitehub/**` and `/api/_vitehub/console/**` routes, including the RPC transport, before it allows a request through. The build cannot verify this policy. Setting `invoke: false` keeps inspection available and disables Agent Invocation creation and manual Schedule runs. The development shorthand `console: true` enables invocation; fixture mode always disables it.

Console RPC requests must come from the same origin. The transport rejects opaque origins and browser requests marked `same-site` or `cross-site`. Browser Fetch Metadata permits same-origin requests through reverse proxies. When that metadata is absent, the transport compares the `Origin` header with the request URL. Hosts must reconstruct the public request origin for older browsers that send `Origin` without Fetch Metadata.

Browsers can omit both headers on HTTP origins. Requests with neither same-origin Fetch Metadata nor an `Origin` header must send `x-vitehub-console: 1`. A foreign browser page cannot add this header without a CORS preflight, which the transport rejects. The built-in Console client adds it to every RPC call automatically. Server clients must add it when they send RPC calls without origin headers. The marker is not a credential. All requests still require the configured authentication and authorization.

The `vitehub:console:agent-invocations` RPC operation accepts an Agent name, `method: 'POST'`, and a body typed as `ConsoleAgentInvocationInput` from `vite-hub/console`. The body requires a non-empty `prompt` and can include a configured `invokerProfileId` and prior `messages`.

```ts
import { createMessage } from 'vite-hub/agent'
import type { ConsoleAgentInvocationInput } from 'vite-hub/console'

const body = {
  messages: [
    createMessage({ role: 'user', text: 'Which receipt date?' }),
    createMessage({ role: 'assistant', text: 'The promised date.' }),
  ],
  prompt: 'And if that is blank?',
} satisfies ConsoleAgentInvocationInput
```

History must contain valid ViteHub Messages with `user` or `assistant` roles and unique IDs. Parts must be `text`, `file`, `image`, or `audio`. The Console preserves message metadata and appends the new prompt as a user Message. It rejects malformed Messages, `system` or `tool` roles, and other parts before starting the Agent. This includes tool calls, tool results, and approval parts nested in user or assistant Messages. Omit `messages` for a prompt-only invocation. Each request creates a new invocation; history does not resume a previous runtime session.


Nuxt does not need an SEO module for the `X-Robots-Tag` default. If the app already uses `@nuxtjs/robots` or `@nuxtjs/seo`, add route metadata so its robots and sitemap modules also know that Console pages are not indexable:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  routeRules: {
    '/_vitehub': { robots: false },
    '/_vitehub/**': { robots: false },
  },
})
```

Do not use `robots.txt` as access control. A crawler can ignore it, and a disallowed URL may still be listed without its contents.

Read [Auth](/docs/server-primitives/auth#authorize-access-routes) for sign-in redirects and the complete callback contract.

### Run Schedules on demand

The same `invoke` setting enables manual Schedule runs. The Schedules page shows a **Run now** button next to the **Read-only** badge for each Static Schedule Definition that sets `manual: true`. The run status, duration, run id, and error replace the page notice after the run finishes. The Console omits the error stack.

[`vitehub schedule run --url`](/docs/development/cli#run-a-schedule-on-demand) uses `POST /_vitehub/schedules/run` with a JSON body `{ "name": "sync" }`. The route is under `/_vitehub/**`, so the Console access policy protects it. It accepts only `application/json` requests and rejects a cross-origin `Origin` header. With `invoke: false`, or for a definition without `manual: true`, the route returns `404`. The Console UI uses the `vitehub:console:schedule-run` RPC operation with the same rules.

## Know what the Console stores

When Agents are configured, the Console installs a fallback Agent Invocation journal. Development and Node builds store it at `.vitehub/data/console.sqlite`. [Cloudflare builds](#cloudflare-journal) store it in the D1 Database binding. It retains invocation records and selected searchable text, including prompts, messages, final text, progress updates, and generated session titles. A KV-only Console does not install the Agent journal or Agent read endpoints.

Console image uploads use the configured Blob store. Before each fresh upload, the Console retries at most 100 pending rollback records. Malformed batch records move to `vitehub-console-attachment-quarantine/batch/<id>` with their original contents preserved. Fresh uploads continue, but stored attachment references remain unavailable while any quarantine record exists because its deletion ownership is unknown. Existing retained image bytes are not deleted by quarantine.

To repair a quarantined record, recover its original attachment UUIDs from trusted storage history and write their JSON array (1–10 UUIDs) to `vitehub-console-attachment-cleanup/batch/<id>`. After a later upload successfully drains that cleanup record, remove the corresponding quarantine object through the Blob provider. Keep the quarantine record if its original UUIDs cannot be recovered; guessing could delete retained images.

Set `observations` on the Console configuration when the fallback journal needs larger records or more time to drain pending writes:

```ts
console: {
  exposure: 'host-managed',
  observations: {
    maxCount: 1024,
    maxStringLength: 131072,
    maxBytes: 16777216,
    flushTimeoutMs: 10000,
  },
}
```

These limits apply only to the Console fallback journal. If discovered Agent Definitions configure a shared journal, set its limits in `defineAgentInvocations()` instead. See [Agent Invocations](/docs/agents/invocations) for defaults and supported bounds. Larger limits increase record storage and memory use.

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

The Agent Console uses an invocation journal configured on the discovered Agent Definition. Configure the same journal on every discovered Agent when the Console includes more than one. Distinct journals fail during runtime setup because the Console exposes one combined query interface.

When no Agent Definition configures a journal, the Console falls back to local SQLite at `.vitehub/data/console.sqlite`. This fallback is suitable for development and Node deployments with durable local storage. It is local to one replica and does not survive replacement unless the host persists that path. Netlify, Vercel, and Deno production deployments should configure a durable hosted invocation journal instead.

### Cloudflare journal

A Cloudflare build that uses the Database primitive stores the fallback journal in its D1 binding. ViteHub selects the default Database Definition, or the only Definition. Its `cloudflare.binding` takes precedence over the integration binding. When the Definition has no Cloudflare config, `database: { driver: 'd1' }` supplies the binding, which defaults to `DB`. Set this driver explicitly in Nuxt too. Without a discovered Definition, the Console keeps libSQL:

```ts [vite.config.ts]
vitehub({
  preset: 'cloudflare',
  agent: true,
  console: { exposure: 'host-managed' },
  database: { driver: 'd1', binding: 'DB', databaseName: 'my-app', databaseId: '<id>' },
})
```

The build prints `Console journal: D1 binding DB, table vitehub_agent_invocations`, and the generated `.vitehub/nitro/console/plugin.mjs` passes the binding to `installConsoleAgentDefinitions()`. The journal uses the [D1 store](/docs/agents/invocations#store-invocations-in-cloudflare-d1). It creates its table on first use, so no migration step is necessary. It keeps the D1 store retention defaults: 10,000 terminal records from the last 30 days.

The fallback journal exposes `console.resolve(context).invocations` from `vite-hub/console/server`. It provides `driver`, `db`, and `schema.invocations` for Drizzle queries on D1 and libSQL. Check `driver === 'd1'` or `driver === 'libsql'` before destructuring to narrow the database and schema types. D1 requires non-null `search` and `summary` values on inserts. libSQL reads allow null for those columns while legacy rows await backfill. On D1, each query or batch resolves the Worker binding and creates the journal table before it runs.

Use `db.batch()` for atomic D1 writes. If any statement fails, D1 rolls back the whole batch. D1 does not support Drizzle's callback transactions, so `db.transaction()` rejects with `VITE_HUB_R0123` before the callback runs. The libSQL journal retains its transaction support.

`vite dev` keeps the local SQLite journal. `console.databaseUrl` at build time, or `VITEHUB_CONSOLE_DATABASE_URL` at runtime, selects libSQL instead. An Agent Definition with its own `invocations` still wins. If the binding is missing from the Worker env, journal reads and writes fail with a diagnostic. Agent results do not change.

The Console sends every operation as one `POST /_vitehub/rpc/__call` request with the JSON body `{ method, input }`. The server keeps no session between calls, so any instance can answer any call. The endpoint accepts calls only from the Console origin, as [Start Agent invocations](#start-agent-invocations) describes. Its internal request contract uses `GET` semantics for bounded listings and metadata, and JSON-body `POST` semantics to read a selected KV value without putting an opaque key in the request URL. The KV operation remains read-only. Each operation keeps its own body limit: 64 KiB for most operations, and the image attachment limit for Agent invocations. A successful call returns `200`, or `202` when it starts an Agent invocation. Failed calls use the operation status, such as `400`, `403`, `404`, `405`, or `413`. Responses set `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.

KV inspection calls the configured store's paginated `list`, `get`, and `has` operations. It never calls `set`, `del`, or `clear`. Each key page returns at most 200 entries, and the Console passes the provider's opaque cursor when you load more. Selected values are rendered as text or formatted JSON and truncated at 256 KiB in the response. Listing and reading can still count as provider operations even though they do not change data.

Blob inspection calls only the configured store's `list` operation. It returns at most 100 objects initially and 250 per request, follows provider cursors only when you choose **Load more**, and supports a pathname prefix. It does not call `get`, `head`, `serve`, `sign`, `put`, or `del`. Object contents and provider URLs never enter the Console response. Listing can still incur provider requests and cost.

## Inspect the Agent context

Open an Agent Invocation and expand **Captured setup** to inspect the context resolved for that run. The Console shows the final instruction blocks and the model-visible tools, including each tool's description, input JSON Schema, and output JSON Schema when one is available. This is the post-composition contract after the Agent Definition, Capabilities, and runtime tool resolution have been applied, so it also covers dynamic tools whose contract cannot be generated into static documentation.

Invocation journals are metadata-only by default. In that mode, Captured setup includes tool names but omits instructions, descriptions, and schemas. Configure the Agent's invocation journal with `configuration: 'content'` to retain the resolved context independently of other trace content. `content: 'content'` also retains it. Large journal observations remain subject to ViteHub's trace bounds and are marked when truncated. That context can contain secrets or customer data contributed by application code, so use the same access, retention, and encryption controls as prompts and model output. See [Agent Invocations](/docs/agents/invocations#observe-the-outcome) for configuration details.

## Inspect usage

Open **Usage** in the Console sidebar to inspect provider-reported tokens and cost across the past 24 hours, 7 days, 30 days, or 90 days. The dashboard groups completed Agent Invocations by time and model. A warning appears when the bounded journal scan reaches 10,000 records or a recorded finish event is truncated, so partial totals are never presented as complete.

The Cloudflare fallback journal uses a persisted usage index. Each request projects at most 250 queued invocations and then queries aggregate totals and a page of sessions. Full transcripts stay in D1. Totals remain partial while the projection has queued work; later requests continue the backfill. Updates and deletions keep the index in sync.

Session details also show the normalized usage record for one invocation. Add the [Usage Capability](/docs/capabilities/usage) when the provider needs an explicit usage request, estimated cost, or a typed Agent Usage Record at finish. Providers that report usage without the Capability still appear because the recorded finish event is authoritative.

The Console does not calculate missing provider data. Token counts, model metadata, and provider-reported cost remain absent when the provider does not report them.

## Fix common failures

| Symptom | Check |
| --- | --- |
| `/_vitehub` returns `404` | Confirm `console: true`, then restart the development server. Omitted and false configurations register no route. |
| Agents is absent from the Console home | Configure `agent`. The Console only lists primitives active in the same ViteHub configuration. |
| KV is absent from the Console home | Configure `kv`. The Console only lists stores from the active KV configuration. |
| A KV key page stops at 200 entries | Load the next page or enter a key prefix to narrow the list. The Console does not fetch values until selection. |
| Blob is absent from the Console home | Configure `blob` with a preset that supports Blob or an explicit Blob store. |
| Blob inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to list the configured store. |
| Databases is absent from the Console home | Configure `database`. The Console catalogs Database Definitions only when the integration is enabled. |
| Rate Limits is absent from the Console home | Configure `rateLimit` and use statically declared `requireRateLimit()` policies. |
| Workspaces is absent from the Console home | Configure `workspace` and add a discovered Workspace Definition. |
| Sandboxes is absent from the Console home | Configure `sandbox: true` with a deployment preset that supports Sandbox. |
| KV inspection returns a provider error | Check that the deployed Console runtime has permission and credentials to read the configured store. Read-only Console requests still perform provider reads. |
| Agents opens but has no sessions | Invoke a discovered Agent. Confirm it uses the framework fallback instead of a separate `invocations` store. |
| A production build rejects `console: true` | Configure an explicit production access contract: use `console: { access: 'auth' }` with a callback-backed policy for `/_vitehub/**`, or acknowledge host middleware with `console: { exposure: 'host-managed' }`. |
| Agent Console startup fails on a hosted preset | Configure one durable Agent Invocations journal and attach it to every discovered Agent Definition. The local SQLite fallback requires a writable, persistent filesystem. |
| The page returns `401` | Sign in through the Auth provider configured by the host. |
| The page returns `403` | Check the host's `authorize` callback and the current user's role or permission. |

Use [Agent Invocations](/docs/agents/invocations) for custom stores and invocation lifecycle behavior. Use [Invocation UI](/docs/ui/invocation) when building an application-owned inspection page instead of mounting the complete Console.

### Image upload boundaries

Console image uploads require `console.invoke` to be enabled. The Agent and invoker profile selected when you submit stay fixed while images upload. If you switch Agents, the pending request does not redirect the input or open its result in the new Agent view.

Images must be PNG, JPEG, WebP, or GIF, with at most ten images and 10 MiB combined per invocation. Blob storage must return an HTTP or relative serving URL. The Console rolls back new uploads if storage or invocation setup fails before the Agent takes ownership. Images handed to an Agent remain under `vitehub-console-attachments/` and follow your Blob storage retention policy.

## Inspect capabilities

Open the right panel's tab chooser and select **Capabilities**. Select a Capability to inspect its recorded data and tools. MCP groups tools by server and preserves original tool names and schemas. Title shows its generation settings, progress, and result. Other Capabilities have a default tools and configuration view.

The panel reads the selected Invocation's snapshots. It does not run MCP discovery or title generation. Missing or truncated capture is marked. Developers can [contribute a read-only view](/docs/capabilities/custom-capabilities#contribute-an-inspection-view) with the shared JSON Render component catalog.
