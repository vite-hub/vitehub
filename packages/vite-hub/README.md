# vite-hub

[![npm version](https://comark-ui.onmax.me/badge.svg?source=npm-version&package=vite-hub&icon=npm)](https://npmx.dev/package/vite-hub)
[![npm downloads](https://comark-ui.onmax.me/badge.svg?source=npm-downloads&package=vite-hub&period=month&icon=npm)](https://npmx.dev/package/vite-hub)
[![license](https://comark-ui.onmax.me/badge.svg?label=license&value=Apache-2.0)](https://github.com/vite-hub/vitehub/blob/main/LICENSE)
[![docs](https://comark-ui.onmax.me/badge.svg?label=docs&value=vitehub.dev)](https://vitehub.dev/docs)

`vite-hub` is the ViteHub application distribution. It registers enabled integrations through one `vitehub()` call and exposes application APIs on explicit `vite-hub/*` feature imports.

Use it for a Vite or Nuxt application that needs Server Primitives, Agents, or both. Install an `@vite-hub/*` owner package directly when you are building a library, another framework integration, or a custom package composition.

`VITEHUB_HOST` selects the deployment host and is reserved. For an application Env field named `host`, use `env.source("APP_HOST", { canonical: false })` or a custom Env prefix.

## Install

```sh
pnpm add vite-hub
```

If pnpm stops with `ERR_PNPM_IGNORED_BUILDS` and names `esbuild`, the packages from that command are installed. Run `pnpm approve-builds esbuild` one time to let esbuild run its install script.

`vite-hub` includes Env, Source, Logs, and the Console endpoint. Every other feature is an optional peer, so an app installs and loads only what it enables. An app without features installs no feature package. Add their packages before you enable them:

| Feature | Add these packages |
| --- | --- |
| `agent` | `@vite-hub/agent @vite-hub/workflow` (Agents run on Workflow) |
| `auth` | `@vite-hub/auth better-auth` |
| `blob` | `@vite-hub/blob` |
| `browser` | `@vite-hub/browser` |
| `channels` | `@vite-hub/channels` |
| `connections` | `@vite-hub/connections @vite-hub/database drizzle-orm` |
| `database`, and Connections or Comments, which turn Database on | `@vite-hub/database drizzle-orm`, and `drizzle-kit` as a development dependency |
| `email` | `@vite-hub/email` |
| `kv`, and `cache: { driver: "kv" }` | `@vite-hub/kv` |
| `queue` | `@vite-hub/queue` |
| `rateLimit` | `@vite-hub/rate-limit` |
| `mcp` | `@vite-hub/mcp`, and with `auth` also `@better-auth/oauth-provider` |
| `realtime` | `@vite-hub/realtime` |
| `sandboxTask` | `@vite-hub/sandbox` |
| `schedule` | `@vite-hub/schedule` |
| `workflow` | `@vite-hub/workflow` |
| `workspace` | `@vite-hub/workspace`, and `@vite-hub/shell` for shell commands |
| `server/content.ts` | `@vite-hub/content`, and `@vite-hub/cms` for the `cms` preset |
| `server/comments.ts` | `@vite-hub/comments` |
| `.template.md` imports | `@vite-hub/markdown-template` |
| Console with Agents | `@libsql/client drizzle-orm` |
| Console MCP client (`console.mcpClient`) | `@modelcontextprotocol/sdk` |
| `vite-hub/decisions` | `@vite-hub/decisions` |
| `vite-hub/forge` | `@vite-hub/forge` |
| `vite-hub/gateways` | `@vite-hub/gateways` |
| `vite-hub/ui` | `@vite-hub/ui` |
| `vite-hub/console/ui` | `@vite-hub/ui @json-render/core @json-render/vue @vueuse/core` |
| `vite-hub/docs/*` | `@vite-hub/docs` |
| `vite-hub/presets/*` | `@vite-hub/presets` |

A build with an enabled feature whose package is missing fails with the `pnpm add` command to run. When an installed package is outside the range that `vite-hub` supports, the build continues and warns with the `pnpm add` command that installs a supported version. Vercel Workflow requires `@vercel/functions` for all definitions; add `workflow` and `@workflow/builders` for native durable definitions. See the [Workflow hosts guide](https://vitehub.dev/docs/workflows/hosts) for installation. Other provider SDKs, such as `@vercel/sandbox` for Sandbox Tasks, stay with their feature guides.

You need Node.js 22.22 or newer, Vite 8 or newer, and an ESM package with `"type": "module"` or a `vite.config.mts` file. Hosted primitives and model providers can also require credentials, network access, and billed accounts. Their feature guides list those requirements before the first provider call.

## Configure ViteHub

Choose one built-in deployment host. Application routes and feature imports stay unchanged when the target changes. When you omit `host`, ViteHub detects it from `VITEHUB_HOST`, then `NITRO_PRESET` or `SERVER_PRESET`, then the build variables of Cloudflare Workers Builds (`WORKERS_CI`), Netlify (`NETLIFY`), Vercel (`NOW_BUILDER`, `VERCEL`, `VERCEL_ENV`), and Deno Deploy (`DENO_DEPLOY`, `DENO_DEPLOYMENT_ID`). Without any of them, it builds for `node`. `detectHost()` from `vite-hub` returns the same detected host, or `undefined`, so a config can choose host-specific options.

```ts
// vite.config.ts
import { vitehub } from "vite-hub";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vitehub({ host: "node" })],
});
```

This registers ViteHub's build integration. Your application still needs a server entry or a framework such as Nuxt. For Nuxt, use the `vite-hub/nuxt` module shown in the [installation guide](https://vitehub.dev/docs/getting-started/installation).

On Nuxt 5, the module auto-imports the server helpers of each enabled feature, such as `kv`, `db`, and `sendQueue`. Set `nitro: { imports: false }` to turn them off. Read [Nuxt server auto-imports](https://vitehub.dev/docs/frameworks-hosts/nuxt-server-auto-imports).

On a Node host with persistent storage, set `dataDir` once. Enabled Agent State, Agent Invocation journal, KV, Blob, and Workspace integrations derive local paths from it. For example, `vitehub({ host: "node", dataDir: "/var/lib/app", agent: true, kv: true, blob: true, workspace: true })` uses that directory without per-store environment variables. Relative paths resolve from the configuration process's working directory. The host must mount persistent storage there; `dataDir` does not create a volume. Other hosts require their own storage providers.

Set `publicUrl` to the public origin of the deployed application, for example `vitehub({ host: "node", publicUrl: "https://agents.example.com" })`. Console invocation links, GitHub activity links, telemetry session links, and the default Auth base URL use it. A function receives each discovered Agent name. It applies to builds. In `vite dev`, request-bound Console and Auth flows use the request origin. GitHub activity and telemetry links have no request-origin fallback. Use the GitHub Channel `activity.publicUrl` override or the evlog `sessionUrl` callback to supply links in development. Server code reads the origin with `resolvePublicUrl()` from `vite-hub/runtime`, also in Workflows. A string `publicUrl` is also the default `--url` of `vitehub channels sync` and `channels history`. On the `cloudflare` host, it adds the custom-domain route and `workers_dev: false` to `wrangler.json` unless the app configures Worker routing.

Explicit store paths, remote URLs, and disabled services remain authoritative. Set `agent.invocations.databaseUrl` to preserve an existing journal location; `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` remains a runtime override. Changing paths does not migrate existing data.

## Run a complete first result

Choose the result that matches the application you are building:

- [First Server Primitive](https://vitehub.dev/docs/getting-started/first-server-primitive) builds and starts a local Node server, writes and reads a KV value, and returns `{"settings":{"theme":"system"}}` from `curl`.
- [First Agent](https://vitehub.dev/docs/getting-started/first-agent) builds and starts a local Node server, runs an offline Agent Invocation, and returns `{"text":"Hello, Ada. This result came from an Agent Invocation."}`.

Both guides use `vite-hub`, include complete files and commands, and need no provider credentials. Do not treat the configuration fragment above as a successful runtime check by itself.

Custom H3 and Nuxt routes can import `getRuntimeContext` from
`vite-hub/runtime`. Call it once per invocation to read the event's
Standard Context (`event["~standard"]`): request, bindings, host `waitUntil`,
and a fresh memo cache. Without a real host lifetime API, await the
returned `flushWaitUntil()` before responding. See the
[Runtime Context guide](https://vitehub.dev/docs/reference/runtime-context).

The public hosts are `cloudflare`, `netlify`, `vercel`, `deno`, and `node`. Each resolves once to a host, runtime, Nitro output, packaging policy, and service adapters. The build fails when `nitro.preset`, `NITRO_PRESET`, `SERVER_PRESET`, or `VITEHUB_HOST` selects a different host than `host`.

ViteHub derives one deployment identity from the nearest `package.json` name, falling back to the Vite root directory name. Set `name` to pin the identity explicitly. Cloudflare Workers Builds supplies its connected Worker through `WRANGLER_CI_OVERRIDE_NAME`; the Cloudflare host uses it after explicit `name` and fails when the two resolve to different values because the connected Worker remains the deployment target. Cloudflare uses the resolved identity for the default Worker, Blob bucket, Queue prefix, Rate Limit namespace, Sandbox, and Container names. Explicit Wrangler Worker names remain authoritative outside Workers Builds, while explicit Blob bucket, driver, and store options still win. The Workers Builds fallback derives deterministic names but does not provision the corresponding R2 bucket or Queue.

Blob, Agent, Auth, Database, Email, KV, Queue, Rate Limit, Sandbox, Schedule, Workflow, and Workspace are opt-in. Enabling Agent also enables Workflow for discovered Agent Definitions; set `workflow: false` only when every Agent must stay inline:

```ts
import { vitehub } from "vite-hub"

vitehub({
  agent: true,
  blob: true,
  host: "cloudflare",
  auth: true,
  database: true,
  email: {
    driver: "resend",
  },
  kv: true,
  queue: true,
  rateLimit: true,
  sandboxTask: true,
  schedule: true,
  workflow: true,
  workspace: true,
});
```

See [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix) for the providers, limitations, and proof available on each host.

Discovered Database Definitions do not enable Database. Without `database`, importing `vite-hub/database` or `@vite-hub/database` fails the build, and `vitehub database` reports that Database is disabled. A directly composed `hubDatabase()` still provides Database.

If an enabled capability is not supported by the host, the build fails. You can instead configure an explicit Blob driver through `blob` or compose an owner package directly when the application provides its own portable implementation.

The Deno host uses Nitro's Deno entrypoint, so it rejects Schedule and `agent.runtime: "deno"`; those owner-package outputs require an explicit deployment integration.

The Deno host emits `.output/deno.json`, stages under `.output/node_modules` the packages that the server bundle keeps external and the Linux glibc binaries that bundled packages load at runtime, such as libSQL's native module, and writes `.output/deploy.mjs`, a non-interactive create-or-update runner used by the `node ./deploy.mjs` command in `.output/nitro.json`; set `DENO_DEPLOY_ORG` before deployment. The runner uses the resolved deployment identity as its app name, with `DENO_DEPLOY_APP` as an optional override, and uploads node modules when it creates or updates an app. The Node host emits a plain Node server artifact suitable for a VPS or container image; Docker is not a host.

Literal package calls through `createRequire` are staged when they survive tree shaking and their resolution base is an absolute path, a file URL, `import.meta.url`, or a static `new URL(..., import.meta.url)`. For a base computed at runtime, import the package or mark it external so the build can stage it.

## Build, inspect, and deploy

The host tells ViteHub which integrations and Provider Output to generate. Depending on the host and enabled features, a build can write Runtime Registries under `.vitehub`, Cloudflare Worker output and `wrangler.json` under `dist`, Vercel Build Output under `.vercel/output`, Netlify functions under `.netlify/v1`, or Node and Deno artifacts under `.output`.

Nuxt's Cloudflare preset enables Nitro deployment configuration by default and
writes `.output/server/wrangler.json`. Set `nitro.cloudflare.deployConfig: false`
only when you manage that configuration yourself. With `cloudflare: { secretsFile: ".env" }`,
`nitro deploy --prebuilt` also uploads that file's values as Worker secrets when the file exists at build time.
See [Upload secrets from a file](https://vitehub.dev/docs/frameworks-hosts/cloudflare#upload-secrets-from-a-file).

A successful build proves that ViteHub discovered the configured definitions and wrote the selected output. It does not prove that remote resources exist, credentials are valid, deployment succeeded, or a hosted provider completed a live operation. Follow the selected [host guide](https://vitehub.dev/docs/frameworks-hosts) for provisioning, environment variables, deployment commands, and current proof.

Generated files are for inspection and deployment. Application code must not import `.vitehub/**`, provider output directories, or Vite virtual module IDs. Use the public paths in the [import reference](https://vitehub.dev/docs/reference/import-paths).

Nitro output includes `.vitehub/nitro/error-log.mjs`. It logs each unhandled request error as `[vitehub] Unhandled error in <method> <path>` with the thrown error's message, stack, status, and cause chain, while the response stays sanitized. Without it, Cloudflare Workers log only `{"status":500,"unhandled":true,"message":"HTTPError"}`. `vitehub({ observability })` replaces it with evlog.

`vitehub({ health: true })` adds `/api/_vitehub/health` for load balancers and container health checks, on every host. It answers `{ ok: true, commit }`, where `commit` is the commit of the build from the CI or host variables, else from Git, else `null`. With `database`, it also runs `SELECT 1` on each Database and answers `503` with `ok: false` when one fails, for example `{ ok: false, commit, databases: { default: false } }`. The error goes to the server log, never to the response. `health: { route: "/api/health" }` moves the route.

`vitehub({ trustProxy: true })` trusts a proxy that ends TLS: when the server sees `http:` and the first `X-Forwarded-Proto` value is `https`, the request URL becomes `https:` before any middleware or route runs. It never reads `X-Forwarded-Host`. `vitehub({ sameOriginWrites: true })` answers `403` to a write with cookies whose `Sec-Fetch-Site` is `same-site` or `cross-site`, or whose `Origin` is not the app's origin; `exclude` lists path prefixes that take writes from other sites. See [Run behind a reverse proxy](https://vitehub.dev/docs/frameworks-hosts/node-self-hosted#run-behind-a-reverse-proxy).

`vitehub()` and `vite-hub/nuxt` register ViteHub rules with [Vite Doctor](https://github.com/onmax/vite-doctor) when the app runs it. The rules report misuse of every Server Primitive, for example internal or server-only imports, unchecked `[error, value]` results, secret Server Env values used as strings, unknown Definition names, and removed APIs. Read [Doctor rules](https://vitehub.dev/docs/reference/doctor-rules).

## Run tasks

A task is a [Nitro task](https://nitro.build/docs/tasks) in `server/tasks/`. Use it for seeds, backfills, data repair, and one-off admin jobs. `vitehub()` registers each file with Nitro, so the app does not set `nitro.serverDir` or `nitro.experimental.tasks`.

This seed task adds a row to the `notes` table of the default Database:

```ts
// server/databases/default.ts
import { defineDatabase } from "vite-hub/database";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export default defineDatabase({
  schema: {
    notes: sqliteTable("notes", {
      id: integer("id").primaryKey({ autoIncrement: true }),
      title: text("title").notNull(),
    }),
  },
});
```

```ts
// server/tasks/db/seed.ts
import { useDatabase } from "vite-hub/database";
import { defineTask } from "nitro/task";

export default defineTask({
  meta: { description: "Add one demo note" },
  async run({ payload }) {
    const { db, schema } = useDatabase("default");
    const [note] = await db.insert(schema.notes).values({ title: String(payload.title ?? "Hello") }).returning();
    return { result: note };
  },
});
```

Start `vite dev`, then run the task from another terminal. The task runs in the dev server's Nitro runtime, with the same bindings as a request.

```sh
pnpm vitehub task list
pnpm vitehub task run db:seed '{"title":"First note"}' --yes
```

`vitehub inspect definitions --kind task` lists the task files without a running server. Read the [CLI guide](https://vitehub.dev/docs/development/cli#run-app-tasks) for payload options and limits.

## Configure TypeScript

Extend `vite-hub/tsconfig` to load ViteHub's generated declarations without adding `.vitehub` to your application `include`. This config requires TypeScript 5.5 or newer.

```json
{
  "extends": ["vite-hub/tsconfig"],
  "include": ["server/**/*.ts", "vite.config.ts"]
}
```

Run `vitehub types prepare` after installation so editors have `.vitehub/types.d.ts` before the first dev build:

```json
{
  "scripts": {
    "postinstall": "vitehub types prepare"
  }
}
```

Vite config resolution and builds also refresh the entry. Defining `files` in the application config replaces the inherited entry, so include `.vitehub/types.d.ts` there when taking ownership of `files`.

## Use feature APIs

```ts
import { defineAgent } from "vite-hub/agent";
import { workspaceShell } from "vite-hub/agent/capabilities";
import { env } from "vite-hub/env";
import { renderMarkdownFile } from "vite-hub/markdown-template/file";
import { renderMarkdownTemplate } from "vite-hub/markdown-template";
import { defineWorkspace } from "vite-hub/workspace";
import { defineWorkflow } from "vite-hub/workflow";
```

The root export intentionally contains only the framework configuration API. Feature code belongs on a feature subpath. Each feature subpath is `export * from "@vite-hub/<feature>"` and nothing else, so `vite-hub/agent` and `@vite-hub/agent` behave the same. `test/pure-facades.test.ts` enforces it.

Render a local prompt with `renderMarkdownFile(new URL("./prompt.md", import.meta.url), { data })`. File rendering reads only the requested file at runtime; references such as `@./fragment.md` remain literal, so compose any additional Markdown explicitly before rendering. Use `renderMarkdownTemplate(text, { data })` for content already loaded from a Workspace, Source, or application storage.

Built-in Agent Drivers and Sandbox runtimes are selected by literal or tagged values, so they do not need provider-specific ViteHub imports. Install an optional external provider or SDK explicitly when its runtime requires one.

## Read the reference

- [Installation and owner-package selection](https://vitehub.dev/docs/getting-started/installation)
- [Configuration options](https://vitehub.dev/docs/reference/config-options)
- [Runtime and host support](https://vitehub.dev/docs/frameworks-hosts/support-matrix)
- [Generated files](https://vitehub.dev/docs/development/generated-files)
- [Public import paths](https://vitehub.dev/docs/reference/import-paths)

## Record Agent invocations

An app with Nitro-hosted Agents records their invocations in the default journal, with the Console on or off. It is local SQLite at `.vitehub/data/agent-invocations.sqlite`, or the D1 binding of the default Database Definition in a Cloudflare production build. The Console only reads it. The Netlify host and `agent.runtime: "deno"` require `agent.invocations: false` and journals configured on each Agent Definition; they reject an omitted or configured app-wide journal with `VITE_HUB_R0132`. Set the default journal options in `agent.invocations`:

```ts
import { vitehub } from "vite-hub"

vitehub({
  agent: {
    invocations: {
      databaseUrl: "file:/var/lib/app/agent-invocations.sqlite",
      retention: { maxAge: "14d", maxSize: "30%" },
      observations: { maxCount: 1024 },
    },
  },
})
```

`databaseUrl` takes a `file:` or libSQL URL, and `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` overrides it at runtime, with `VITEHUB_AGENT_INVOCATIONS_DATABASE_AUTH_TOKEN` for an authenticated endpoint. `retention` takes `maxAge`, `maxRecords`, and `maxSize`. The SQLite journal keeps every terminal record by default; the D1 journal defaults to 30 days and 10,000 terminal records and does not support `maxSize`. On a Worker without D1 or a remote URL, the journal stays in memory. `console.databaseUrl`, `console.retention`, `console.observations`, and `VITEHUB_CONSOLE_DATABASE_URL` are removed and fail with a message that names the new option. ViteHub does not move records from the old `.vitehub/data/console.sqlite` file. See [the default journal](https://vitehub.dev/docs/agents/invocation-storage#use-the-default-journal).

`getAgentInvocations()` from `vite-hub/agent` returns the app-wide journal. `await getAgentInvocationsDatabase()` from `vite-hub/agent/invocations/drizzle` opens Drizzle over the default journal on first use, for queries and atomic writes such as `db.batch()` on D1. Check the returned `driver` before destructuring to narrow the D1 or libSQL database and schema types. D1 inserts require non-null `search` and `summary`; libSQL reads allow null while legacy rows await backfill. The D1 `db.transaction()` method rejects before the callback runs. It resolves to `undefined` for another journal store, for `agent.invocations: false`, and for the in-memory journal of a Worker.

Set `invocations` on an Agent Definition to record into another journal, such as the app's Database:

```ts
import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: { model: "openai/gpt-5.1-mini" },
  invocations: "database",
})
```

Set `agent: { invocations: "database" }` in the `vitehub()` options to give every Agent Definition the same journal. An Agent's own `invocations` value replaces it, and `invocations: false` turns it off. `"memory"` keeps records in the server process. The object form, such as `{ store: "database", database: "journal", content: "content" }`, accepts the other `defineAgentInvocations()` options.

The store uses a discovered ViteHub Database and creates its journal tables on first use. It supports local SQLite and hosted libSQL through Drizzle, plus native Cloudflare D1. D1 over HTTP is rejected by a read-only probe before schema creation or writes because its raw query results do not contain column names. The `database` option defaults to `default`.

Retention defaults to 30 days and 10,000 terminal records. To change a limit, pass `createDatabaseAgentInvocationStore({ maxAge, maxRecords })` from `vite-hub/agent/invocations/database` to `defineAgentInvocations({ store })` from `vite-hub/agent/server`. Set either limit to `false` to disable it. The Console shows a configured journal but does not own its retention settings.

## Invoke Agents from the Console

The Console **Skills** page shows the bundled files of each discovered Agent Definition in a searchable tree. Read Markdown previews or file source, including supporting references and scripts. Source-mounted Skills are available in the session Workspace. See [Inspect Skills](https://vitehub.dev/docs/development/console#inspect-skills).

The Console **Usage** page provides session history with date, Agent, status, and search filters. Open a row to inspect that session in the existing Agents view. History keeps completed, failed, and cancelled Agent Invocations visible even when token or cost evidence is unavailable. Totals use the same filters as the history table. See [Session history and usage](https://vitehub.dev/docs/development/console#inspect-usage) for the identity, coverage, and pagination contract.

Apps do not serve a Console page, a Console MCP, or a Console sign-in. They serve one Console route, `POST /_vitehub/rpc`, which the ViteHub Console at console.vitehub.dev and the CLI call with signed requests. `console: true` takes only requests signed with an Ed25519 key whose public key is in a `VITEHUB_CONSOLE_KEY_<NAME>` runtime env var. `console: { auth: false }` takes calls without a signature from this machine, for development; a production build with it fails with `VITE_HUB_B0022`, even with `authorize` set. `console.auth: "token"`, `console.auth: "app"`, `console.auth: { ... }` (Console Auth), `console.origins`, `console.mcp`, `console.signInPage`, and `console.embed` are removed, and fail the build with `VITE_HUB_B0020` and the fix. See [Move from auth: "app" or Console Auth](https://vitehub.dev/docs/development/console#move-from-auth-app-or-console-auth).

Without a `console` option, `vite dev` serves the operation RPC, so `vitehub <command>` works. `console: false` turns the Console endpoint off completely: no `/_vitehub` route in development or production.

Add `authorize: "./server/console-authorize.ts"` to decide who may use the Console. The file default-exports `defineConsoleAuthorize()` from `vite-hub/console/auth`. It receives the `Request` and the signer and its `key` name: `via: "console"` with the `user` and `team` that the Console signed, or `via: "cli"` with no `user`. When the ViteHub MCP of the Console calls for the user, `surface` is `"mcp"`: the RPC then refuses operations with `mcp: false`, runs the others with the `mcp` surface, and refuses a destructive call that the person did not confirm. An Agent that calls Console operations as tools receives `via: "agent"`, never a signed `via`. With `auth: false`, it receives only the `Request`. It returns `true`, `false`, a `Response`, or `{ sections: ["content"] }` to allow only some Console sections. Every Console operation declares its section, and the server returns `403` outside the allowed sections. The navigation hides the other sections.

Set `console.mcpClient: true` to add the MCP client section. It runs on the server. It connects to the app's own `/mcp` and to other MCP servers with OAuth or a bearer token, as the Console caller, and it can hold several accounts of one server at once. Tokens and MCP sessions stay on the server and never reach the browser: in memory, or sealed in the app's KV store with `VITEHUB_CONSOLE_MCP_KEY`. See [Connect to MCP servers](https://vitehub.dev/docs/development/console#connect-to-mcp-servers).

`invoke` defaults to `true` on the development server and `false` in a production build. Invocation also enables the Schedules page **Run now** button and the `schedule.run` operation (`vitehub schedule run <name>`) for Static Schedule Definitions that set `manual: true`; see [Run Schedules on demand](https://vitehub.dev/docs/development/cli#run-a-schedule-on-demand).

`impersonation: true` adds the `auth.impersonate` and `auth.stop-impersonating` operations. Each returns a one-time link, `GET /_vitehub/rpc?ticket=<ticket>`, that the browser opens on the app. The browser's app session must belong to the email of the signed Console person and have Better Auth's `impersonate` permission. It is off by default. It needs app Auth with Better Auth's admin plugin and `events.store`. The session lasts one hour by default and cannot create credentials.

One-time links also open Content previews (`documents.preview`). A link works once, for 60 seconds, on the app origin and mount that made it, for the person who asked. The app keeps the SHA-256 of each link in Better Auth's verification table, so every instance sees it. A development server without an Auth database keeps them in memory. A production app without one refuses links with `CONSOLE_TICKET_STORE_MISSING`. See [One-time links](https://vitehub.dev/docs/development/console#one-time-links).

Auth changes from the Console, such as `auth.ban`, run as the app user with the email of the signed Console person, with a live app session of that user. CLI calls name no person, so they cannot run Auth changes.

All Console paths use the application base: an explicit ViteHub application base (set from Nuxt `app.baseURL`), otherwise a root-relative Vite `base`. With `base: "/portal/"`, the route is `/portal/_vitehub/rpc`. Absolute and protocol-relative Vite bases such as `https://cdn.example/portal/` and `//cdn.example/portal/` are asset CDN URLs; without an explicit application base, the route stays at the root. Relative bases (`""` or `"./"`) also use root routes. When Nitro `baseURL` matches the application base, Nitro adds it once.

The Console route takes only signed requests on `POST /_vitehub/rpc`. Each caller has an Ed25519 key pair. The app reads the public keys from `VITEHUB_CONSOLE_KEY_<NAME>` variables of the host environment on each request, on Cloudflare from the Worker `env`. A key is 43 base64url characters, the raw 32-byte public key. The ViteHub Console makes one key pair for each linked app and shows its line. `vitehub secret console-key [name]` makes one for the CLI, which signs with `VITEHUB_CONSOLE_PRIVATE_KEY_<NAME>`. A request carries two headers: `x-vitehub-signature: key=<NAME>, t=<seconds>, origin=<app origin>, body=<SHA-256>, v1=<signature>` and `x-vitehub-caller`, the base64url JSON of who calls. The Ed25519 signature covers `vitehub-signature-v1`, the method, the path and query, the app origin, the time, the key name, the SHA-256 of the exact body bytes, and the caller header, one per line. The app origin is `vitehub({ publicUrl })` when it is set, else the URL of the request as the host routed it; `Host` and `X-Forwarded-*` headers never count. The app refuses a time more than 5 minutes off. Refusals are `401` with `CONSOLE_SIGNATURE_MISSING`, `CONSOLE_SIGNATURE_STALE`, `CONSOLE_SIGNATURE_ORIGIN`, `CONSOLE_KEY_UNKNOWN`, `CONSOLE_SIGNATURE_INVALID`, or `CONSOLE_SIGNATURE_BODY`. No key, or a malformed one, is `500` with `CONSOLE_KEY_NOT_CONFIGURED` or `CONSOLE_KEY_MALFORMED`. Bearer tokens and cookies never count. Rotate a key by adding a key with a new name, then removing the old variable. See [Sign Console requests](https://vitehub.dev/docs/development/console#sign-console-requests).

A call without a signature, with `auth: false` or on a dev server without a `console` option, must come from the app origin, or send `x-vitehub-console: 1` without an `Origin` header, so a foreign page cannot call it without a CORS preflight. Browsers cannot call the Console route from another origin. Each Console operation is one stateless `POST /_vitehub/rpc` request with one birpc call as its JSON body, `{ "m": "<operation>", "a": [input], "t": "q", "i": "<id>" }`, and one birpc reply as its response, so hosts such as Cloudflare Workers can send consecutive calls to different instances. The `project.get` operation (`vitehub project info`) returns `{ protocol: 1, name, vitehub, build, comments, sections, operations }`: the `vite-hub` version, the time and Git commit of the production build, the open Comments threads, and the installed sections and operations that `authorize` allows for the caller. It works without Agents. See [Read the project](https://vitehub.dev/docs/development/console#read-the-project).

[console.vitehub.dev](https://console.vitehub.dev) is the Console app, [`@vite-hub/console`](../console). People sign in with GitHub or a passkey, link apps for their team, and the Console server signs each call with the key of the link. It calls apps from its server, so it cannot open a `vite dev` server on your machine; use the `vitehub` commands there. `hostedConsoleUrl(projectUrl, path)` from `vite-hub/runtime` builds a link to one page of a project, such as `https://console.vitehub.dev/open?project=<app URL>&path=/kv`. The Console opens that page of the app of your team with that URL, or Home when your team has not linked it.

Console invocation requests accept a `prompt`, optional `invokerProfileId`, and optional prior `messages`. Use the `ConsoleAgentInvocationInput` type from `vite-hub/console`. History requires valid user or assistant Messages with unique IDs and only text, file, image, or audio parts. The Console rejects tool and approval parts, appends the new user prompt, and starts a new invocation. See the [Console guide](https://vitehub.dev/docs/development/console#start-agent-invocations) for the access and history contracts.

The Console reads the app-wide Agent journal. It does not configure or store one. See [Record Agent invocations](#record-agent-invocations).

`inputCommands({ debug: true })` from `vite-hub/agent/capabilities` adds a `/debug` input command. It replies with the Console URL of the previous Invocation of the same Agent. When the current Invocation has a Channel thread, it uses the previous Invocation in that thread. The Agent Driver does not run. `/debug` needs `vitehub({ console })`; without it, the command replies that the Console is not enabled. A `debug` entry in `commands` replaces the built-in command.

## Console images

The Console accepts up to ten PNG, JPEG, WebP, or GIF images per message, within a combined 10 MiB limit. Configure durable Blob storage to keep the bytes, and content-enabled Invocation storage to keep message references. Agents can return published Blob image URLs in Markdown. See [Console usage](https://vitehub.dev/docs/development/console#image-upload-boundaries).

Console image uploads require invocation to be enabled. The Console fixes the Agent, route, and invoker profile when submission starts, so switching Agents during an upload cannot redirect the input. Uploads without a usable Blob serving URL are removed before the request fails.

## Logs

`vite-hub/logs` uses Evlog's public logger API and adds a read-only `LogSource` contract for existing pipelines. A bounded local buffer supports development inspection without adding an exporter. Read the [Logs guide](https://vitehub.dev/docs/logs) and [Logs contract](src/logs/README.md) for retention, redaction and source ownership.

Logs are part of `observability`. Turn them on with `vitehub({ console: { auth: false }, observability: { logs: true } })` during local development. It attaches a bounded buffer to Evlog's existing drain and reuses an installed Evlog Nitro module. Pass `observability: { evlog: { redact: true }, logs: { maxEntries: 256 } }` to configure Evlog when ViteHub owns its setup. If another integration already installed Evlog, configure the options there.

For production, use `observability: { logs: { source: './server/logs.ts' } }`. That server module must default-export a `LogSource` from `vite-hub/logs/source` that reads the existing backend. Without `observability.service`, this form starts no logger, buffer, SDK, or exporter. `logs: true` fails a production build because a temporary process buffer cannot provide shared production history. The source owns retention and cursor semantics and must apply each advertised filter.

Explorer and Stream keep selected event data in the right inspector. Search includes structured fields. Follow refreshes the newest page every two seconds and is a polling view, not guaranteed delivery of every event. The browser retains at most 1,000 loaded events. The Console shows local retention limits and dropped or evicted counts. The same read operation is available as `vitehub logs list --level error --limit 50 --json` and through Console RPC `logs.list`, under the same section access policy.

With the Cloudflare host and `observability.logs` set, ViteHub defaults the generated Wrangler configuration to `observability: { enabled: true }`. An explicit Wrangler observability configuration is preserved, including `enabled: false`. This enables Cloudflare's native collection. It does not create an exporter, configure a destination, or connect that history to the Console. Those remain owned by the existing backend and its source adapter.

## Agent Skills

`vite-hub/skills` serves the Agent Skills of an app to coding agents from one list. `defineSkills()` reads an `import.meta.glob()` of `skills/**` and starts a skill at each `SKILL.md`. `serveSkills(request, skills)` answers Agent Skills Discovery v0.2.0 at `/.well-known/agent-skills/` (index with digests, `.tar.gz` for a multi-file skill) and v0.1.0 at `/.well-known/skills/`, which `npx skills add <origin>` reads. It returns `undefined` for other paths, so it fits in a middleware. `skillsMcp(skills)` gives the MCP Skills extension results (`skills/list`, `skills/get`, `skill://` resources) for any MCP server library. Pass a function instead of a list to change the skills at runtime. `skillSettings(skills, { store: kv })` adds a switch to each skill: default-export it from `server/skills.ts`, serve `settings.enabled`, and turn skills on and off without a deploy in the Console **Served skills** section or with `vitehub served-skills set <name> false`. Read the [Agent Skills guide](https://vitehub.dev/docs/development/skills).

```ts
// server/middleware/skills.ts
import { defineHandler } from "h3"
import { defineSkills, serveSkills } from "vite-hub/skills"

const skills = defineSkills(import.meta.glob("../../skills/**", { query: "?raw", import: "default", eager: true }))

export default defineHandler(event => serveSkills(event.req, skills))
```

## ViteHub MCP

Apps do not serve a Console MCP. Agents connect to the ViteHub MCP of the Console: `https://console.vitehub.dev/mcp` for docs tools without sign-in, and `https://console.vitehub.dev/mcp/account` with a Console account for docs and project tools, which run the operations of the team's apps with signed calls. An operation sets `mcp: false` to stay out of it, or `mcp: { format }` to shape its text. See [ViteHub MCP](https://vitehub.dev/docs/development/mcp). For an MCP server of your own app, see `vitehub({ mcp: true })` and [MCP server](https://vitehub.dev/docs/mcp).
