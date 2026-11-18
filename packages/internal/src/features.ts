import type { ViteHubHost, DeploymentService } from "./deployment.ts"
import { invariant } from "./invariant.ts"

/**
 * The feature keys of `vitehub({...})`. `vitehub add <feature>` and `vitehub status` read this list before the owner
 * package of a feature is installed, so the catalog is plain data with no owner imports.
 */
export const featureIds = [
  "agent",
  "auth",
  "blob",
  "browser",
  "cache",
  "channels",
  "comments",
  "connections",
  "console",
  "database",
  "email",
  "env",
  "i18n",
  "kv",
  "mcp",
  "observability",
  "queue",
  "rateLimit",
  "realtime",
  "sandboxTask",
  "schedule",
  "workflow",
  "workspace",
] as const
export type FeatureId = (typeof featureIds)[number]

/** `dev` stores default Node development support. Use `featureSupport()` with the configured host for development lookups. */
export const featureHosts = ["dev", "cloudflare", "vercel", "netlify", "deno", "node"] as const
export type FeatureHost = (typeof featureHosts)[number]

export interface NativeHostSupport {
  level: "native"
  /** The default driver that ViteHub selects, such as `cloudflare`. */
  driver: string
  /** Short name for tables, such as `R2`. */
  display: string
  guarantee: "native" | "single-host" | "process-local"
  detail: string
  /** The first override whose environment variable has a non-empty, trimmed value replaces the default. */
  envOverrides?: readonly { env: string, support: Omit<NativeHostSupport, "envOverrides"> }[]
}

/**
 * How a host supports a feature when the app enables it in `vitehub({...})`.
 * - `native`: ViteHub selects a driver for the host. Credentials can still be needed.
 * - `explicit`: the app must set `option` to choose a driver.
 * - `unsupported`: `vitehub({...})` cannot provide the feature on this host.
 */
export type HostSupport
  = | NativeHostSupport
  | {
    level: "explicit"
    display: string
    /** The option path that selects a driver, such as `blob.driver`. */
    option: `${FeatureId}.${string}`
    detail: string
  }
  | { level: "unsupported", detail: string }

/** A feature that this feature turns on, unless the app sets the other feature to `false`. */
export interface FeatureImplication {
  feature: FeatureId
}

/** The starter Definition file that `vitehub add <feature> --name <name>` creates. */
export interface FeatureStarter {
  /** The folder of the Definitions, relative to the project root, such as `server/queues`. */
  dir: string
  /** The path of the Definition `name`, relative to the project root. */
  file: (name: string) => string
  /** The source of a minimal Definition named `name`. */
  template: (name: string) => string
  /**
   * Earlier versions of `template`. `vitehub remove` deletes a file only when it equals the current or an earlier
   * starter, so keep the old template here when you change one.
   */
  previousTemplates?: readonly ((name: string) => string)[]
  /**
   * Other files, relative to the project root, that already define the Definition `name` or that the owner rejects
   * next to it. The starter is not written when one exists.
   */
  conflicts: (name: string) => readonly string[]
}

export interface FeatureDefinition<TId extends FeatureId = FeatureId> {
  id: TId
  title: string
  /** One sentence for pickers and docs. */
  summary: string
  docs: `/docs/${string}`
  /** Whether the feature is unconditionally on when the app does not set its key. */
  enabledByDefault: boolean
  /**
   * Files and folders in the configured server directories (default `server/`) that turn on a feature whose key is
   * unset. A key of `false` keeps the feature off.
   */
  enabledByDiscovery?: readonly string[]
  /** Packages that the app installs for this feature, in `pnpm add` order. */
  packages: readonly string[]
  /** Additional packages selected by literal provider options. */
  providerPackages?: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>
  /** Development dependencies that the app installs for this feature. */
  devPackages: readonly string[]
  implies: readonly FeatureImplication[]
  /** The Deployment Plan service that this feature reads, when it has one. */
  service?: DeploymentService
  hosts: Readonly<Record<FeatureHost, HostSupport>>
  /** The starter Definition, for features with Definition files. */
  definition?: FeatureStarter
  /** Hosts that use `hosts.dev` during development instead of their deployment entry. Node always uses `hosts.dev`. */
  developmentOverrides?: readonly ViteHubHost[]
}

const noHostLimit = "No host limit in ViteHub."

function native(driver: string, display: string, detail: string, guarantee: "native" | "single-host" | "process-local" = "native"): NativeHostSupport {
  return { detail, display, driver, guarantee, level: "native" }
}

function explicit(option: `${FeatureId}.${string}`, display: string, detail: string): HostSupport {
  return { detail, display, level: "explicit", option }
}

function unsupported(detail: string): HostSupport {
  return { detail, level: "unsupported" }
}

function everywhere(driver: string, display: string, detail = noHostLimit): Record<FeatureHost, HostSupport> {
  const support = native(driver, display, detail)
  return { cloudflare: support, deno: support, dev: support, netlify: support, node: support, vercel: support }
}

function feature<TId extends FeatureId>(definition: Omit<FeatureDefinition<TId>, "devPackages" | "enabledByDefault" | "implies" | "packages"> & Partial<Pick<FeatureDefinition<TId>, "devPackages" | "enabledByDefault" | "implies" | "packages">>): FeatureDefinition<TId> {
  return { devPackages: [], enabledByDefault: false, implies: [], packages: [], ...definition }
}

const sourceExtensions = ["ts", "mts", "js", "mjs", "cts", "cjs"] as const

/** `<base>.<ext>` for each source extension. */
function sourceFiles(base: string): string[] {
  return sourceExtensions.map(extension => `${base}.${extension}`)
}

/**
 * A starter for Definitions in `dir`, one `<name>.ts` file each. With `suffix`, the owner also discovers the Vite
 * form `src/<name>.<suffix>.ts`, and a Definition folder `<dir>/<name>/` when `folder` names its entry file.
 */
function starter(dir: string, template: (name: string) => string, options: { suffix?: string, folder?: string } = {}): FeatureStarter {
  return {
    conflicts: name => [
      ...sourceFiles(`${dir}/${name}`).slice(1),
      ...(options.folder ? sourceFiles(`${dir}/${name}/${options.folder}`) : []),
      ...(options.suffix ? [...sourceFiles(`src/${name}.${options.suffix}`), ...sourceFiles(`${name}.${options.suffix}`)] : []),
    ],
    dir,
    file: name => `${dir}/${name}.ts`,
    template,
  }
}

export const features: { readonly [K in FeatureId]: FeatureDefinition<K> } = {
  agent: feature({
    definition: starter("server/agents", name => `import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: { run: () => ({ text: "Hello from ${name}." }) },
})
`, { folder: "agent", suffix: "agent" }),
    docs: "/docs/agents",
    enabledByDiscovery: ["agents"],
    hosts: {
      ...everywhere("nitro", "Nitro"),
      deno: native("nitro", "Nitro", "Agent routes run in the Nitro output. The Agent Deno runtime is not supported on this host."),
      netlify: native("nitro", "Nitro", "Agent HTTP routes run in generated functions. `agent.invocations` is not supported."),
    },
    id: "agent",
    packages: ["@vite-hub/agent"],
    summary: "Agents in `server/agents/` with tools, Capabilities, channels, and invocations.",
    title: "Agent",
  }),
  auth: feature({
    docs: "/docs/auth",
    enabledByDiscovery: sourceFiles("auth"),
    hosts: everywhere("better-auth", "Better Auth"),
    id: "auth",
    packages: ["@vite-hub/auth", "better-auth"],
    summary: "Better Auth sign-in, sessions, and organizations, with tables that ViteHub owns.",
    title: "Auth",
  }),
  blob: feature({
    docs: "/docs/blob",
    hosts: {
      cloudflare: native("cloudflare", "R2", "Cloudflare R2 binding or S3-compatible HTTP access."),
      deno: explicit("blob.driver", "S3", "Use a remote S3-compatible store. No Deno-native Blob driver is provided."),
      dev: native("fs", "fs", "Local filesystem storage for development.", "single-host"),
      netlify: native("netlify-blobs", "Netlify Blobs", "Netlify Blobs selected from the detected host."),
      node: native("fs", "fs / S3", "Filesystem, S3-compatible, MinIO, or files-sdk drivers.", "single-host"),
      vercel: native("vercel", "Vercel Blob", "Vercel Blob through the vercel driver."),
    },
    id: "blob",
    packages: ["@vite-hub/blob"],
    providerPackages: { driver: { s3: ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"] } },
    service: "blob",
    summary: "Object storage for files and uploads, with one API on every host.",
    title: "Blob",
  }),
  browser: feature({
    docs: "/docs/browser",
    enabledByDiscovery: ["browsers"],
    hosts: {
      cloudflare: native("cloudflare", "Browser Run", "Cloudflare Browser Run binding and provider output."),
      deno: unsupported("Browser Definitions do not have a Deno provider."),
      dev: unsupported("Browser Definitions need the Cloudflare host. Use createBrowser({ driver: localBrowser({ executablePath }) }) from code for a trusted local process."),
      netlify: unsupported("Browser Definitions do not have a Netlify provider."),
      node: unsupported("The Node host has no built-in Browser Provider. Use localBrowser() from code for a trusted process."),
      vercel: unsupported("Browser Definitions do not have a Vercel provider."),
    },
    id: "browser",
    packages: ["@vite-hub/browser"],
    service: "browser",
    summary: "Headless browser sessions for Agents and server code.",
    title: "Browser",
  }),
  cache: feature({
    developmentOverrides: ["cloudflare", "deno", "vercel"],
    docs: "/docs/reference/config-options",
    hosts: {
      cloudflare: native("cloudflare", "Workers KV", "Workers KV binding `CACHE`."),
      deno: native("deno-kv", "Deno KV", "Native Deno KV."),
      dev: native("fs-lite", "fs-lite", "`.vitehub/data/cache` during development.", "single-host"),
      netlify: explicit("cache.driver", "KV", "`cache: true` has no default store on Netlify. Set `cache: { driver: \"kv\" }` and enable `kv`."),
      node: native("fs-lite", "fs-lite", "`.vitehub/data/cache` on the server disk.", "single-host"),
      vercel: native("vercel", "Runtime Cache", "Vercel Runtime Cache."),
    },
    id: "cache",
    summary: "Storage for Nitro's cache mount, used by defineCachedFunction() and defineCachedEventHandler().",
    title: "Cache",
  }),
  channels: feature({
    docs: "/docs/channels",
    enabledByDiscovery: ["channels"],
    hosts: everywhere("nitro", "Nitro"),
    id: "channels",
    packages: ["@vite-hub/channels"],
    summary: "Chat channels such as Slack, Discord, and GitHub that deliver messages to Agents.",
    title: "Channels",
  }),
  comments: feature({
    docs: "/docs/comments",
    enabledByDiscovery: ["comments.ts", "comments.mts", "comments.js", "comments.mjs"],
    hosts: everywhere("database", "Database"),
    id: "comments",
    implies: [{ feature: "database" }],
    packages: ["@vite-hub/comments"],
    summary: "Comments on the app's pages, stored in a ViteHub Database.",
    title: "Comments",
  }),
  connections: feature({
    docs: "/docs/connections",
    enabledByDiscovery: ["connections"],
    hosts: everywhere("database", "Database"),
    id: "connections",
    implies: [{ feature: "database" }],
    packages: ["@vite-hub/connections", "@vite-hub/database", "drizzle-orm"],
    summary: "OAuth and API key Connections in `server/connections/`, with grants stored in a Database.",
    title: "Connections",
  }),
  console: feature({
    docs: "/docs/development/console",
    hosts: everywhere("nitro", "Nitro"),
    id: "console",
    // The Console app is hosted at console.vitehub.dev. The app serves only its Operations endpoint and MCP.
    packages: [],
    summary: "The Operations endpoint and MCP at `/_vitehub`, which the hosted Console at console.vitehub.dev and the CLI call.",
    title: "Console",
  }),
  database: feature({
    definition: {
      // `src/database.ts` is also the Default Definition, and the owner rejects it beside Named Definitions.
      conflicts: name => [
        ...sourceFiles(`server/databases/${name}`).slice(1),
        ...sourceFiles(`server/databases/${name}/index`),
        ...(name === "default" ? ["src/database.ts"] : [...sourceFiles(`src/${name}.database`), "src/database.ts"]),
      ],
      dir: "server/databases",
      file: name => `server/databases/${name}.ts`,
      template: name => `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({
${name === "default" ? "" : `  name: ${JSON.stringify(name)},\n`}  schema: {
    notes: sqliteTable("notes", {
      id: integer("id").primaryKey(),
      title: text("title").notNull(),
    }),
  },
})
`,
    },
    developmentOverrides: ["deno", "netlify", "vercel"],
    devPackages: ["drizzle-kit"],
    docs: "/docs/database",
    hosts: {
      cloudflare: native("cloudflare", "D1", "Cloudflare D1 binding, with authenticated HTTP available for development. A PostgreSQL Database Definition connects through Hyperdrive or `connection.url`."),
      deno: explicit("database.connection", "libSQL / D1 / Postgres", "Configure hosted libSQL, D1 over authenticated HTTP, or a PostgreSQL Database Definition. No Deno-native database driver is provided."),
      dev: native("sqlite", "SQLite", "Local SQLite through libSQL and Drizzle.", "single-host"),
      netlify: explicit("database.connection", "libSQL / D1 / Postgres", "Configure hosted libSQL, D1 over authenticated HTTP, or a PostgreSQL Database Definition. No Netlify-native database driver is provided."),
      node: native("sqlite", "SQLite / libSQL / Postgres", "SQLite or hosted libSQL through the selected Database connection, or a PostgreSQL Database Definition.", "single-host"),
      vercel: explicit("database.connection", "libSQL / D1 / Postgres", "Configure hosted libSQL, D1 over authenticated HTTP, or a PostgreSQL Database Definition. The default local SQLite file is not supported in Vercel functions."),
    },
    id: "database",
    packages: ["@vite-hub/database", "drizzle-orm"],
    summary: "Drizzle Databases in `server/databases/` with migrations and a local SQLite in development.",
    title: "Database",
  }),
  email: feature({
    docs: "/docs/email",
    hosts: {
      cloudflare: native("cloudflare", "Cloudflare Email", "The Cloudflare Email driver is the default. Resend is also supported."),
      deno: explicit("email.driver", "Resend", "Configure the built-in fetch-based Resend driver."),
      dev: native("log", "Log", "`email: true` keeps each message in the development outbox and sends nothing. Set `email.driver` for a production build.", "process-local"),
      netlify: explicit("email.driver", "Resend", "Configure the built-in Resend driver."),
      node: explicit("email.driver", "Resend / custom", "Configure Resend or provide a custom ViteHub Email driver."),
      vercel: explicit("email.driver", "Resend", "Configure the built-in Resend driver."),
    },
    developmentOverrides: ["deno", "netlify", "vercel"],
    id: "email",
    packages: ["@vite-hub/email"],
    summary: "Send email from server code and Agents, with a development outbox.",
    title: "Email",
  }),
  env: feature({
    docs: "/docs/env",
    enabledByDefault: true,
    hosts: everywhere("nitro", "Nitro"),
    id: "env",
    summary: "Typed environment variables and secrets, validated at build and at runtime.",
    title: "Env",
  }),
  i18n: feature({
    docs: "/docs/i18n",
    hosts: everywhere("nitro", "Nitro 3", "Requires Nitro 3 with request async context, or Nuxt 5. Nuxt 4 and Nitro 2 are unsupported."),
    id: "i18n",
    packages: ["@vite-hub/i18n"],
    summary: "Messages with translation records for each locale and a locale for each request.",
    title: "I18n",
  }),
  kv: feature({
    developmentOverrides: ["netlify"],
    docs: "/docs/kv",
    hosts: {
      cloudflare: native("cloudflare", "Workers KV", "Cloudflare Workers KV binding."),
      deno: native("deno-kv", "Deno KV", "Native Deno KV through Deno.openKv()."),
      dev: native("fs-lite", "fs-lite", "Local filesystem-backed KV for development.", "single-host"),
      netlify: explicit("kv.driver", "Upstash / Redis", "Set `kv.driver` to `upstash`, `redis`, or `database`, or set Upstash REST credentials at build time. No Netlify-native KV output is provided. Without them, KV uses a Postgres Default Database, else `fs-lite` files that other function instances cannot read."),
      node: native("fs-lite", "Redis / Postgres / fs-lite", "A table in a Postgres Default Database, else local files. Redis requires kv: { driver: 'redis' }; REDIS_URL supplies its URL on every server. Upstash with REST credentials at build time.", "single-host"),
      vercel: native("upstash", "Upstash", "Upstash Redis with KV REST credentials."),
    },
    id: "kv",
    packages: ["@vite-hub/kv"],
    summary: "Key-value storage with one API on every host.",
    title: "KV",
  }),
  mcp: feature({
    docs: "/docs/mcp",
    hosts: everywhere("nitro", "Nitro"),
    id: "mcp",
    packages: ["@vite-hub/mcp"],
    summary: "The app's own MCP server, with one tool per file in `server/mcp/tools/`.",
    title: "MCP server",
  }),
  observability: feature({
    docs: "/docs/agents/observability",
    hosts: everywhere("evlog", "Evlog"),
    id: "observability",
    packages: ["evlog"],
    summary: "Request logs through Evlog, the logs that the Console reads, and Agent telemetry with a service name.",
    title: "Observability",
  }),
  queue: feature({
    definition: starter("server/queues", name => `import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ id: string }>(async ({ payload }) => {
  console.log("${name}", payload.id)
})
`, { suffix: "queue" }),
    docs: "/docs/queue",
    enabledByDiscovery: ["queues"],
    hosts: {
      cloudflare: native("cloudflare", "Queues", "Cloudflare Queues bindings and consumers."),
      deno: unsupported("No Deno Queue driver is provided."),
      dev: native("local", "Local driver", "The local driver stores jobs in .vitehub/data/queue and runs them in the dev server process.", "single-host"),
      netlify: unsupported("Netlify has no Queue driver, so `vitehub({ queue })` fails on Netlify."),
      node: native("local", "Postgres / local driver", "With a Postgres Default Database, the postgres driver keeps jobs in Postgres and every instance runs them. Else the local driver keeps jobs on the disk of one host.", "single-host"),
      vercel: native("vercel", "Vercel Queues", "Vercel Queues callbacks and runtime client."),
    },
    id: "queue",
    packages: ["@vite-hub/queue"],
    providerPackages: { driver: { postgres: ["postgres"] } },
    service: "queue",
    summary: "Background jobs in `server/queues/` with retries and delivery on every supported host.",
    title: "Queue",
  }),
  rateLimit: feature({
    developmentOverrides: ["cloudflare"],
    docs: "/docs/rate-limit",
    hosts: {
      cloudflare: native("cloudflare", "Cloudflare", "Native Cloudflare Rate Limiting binding."),
      deno: unsupported("ViteHub has no native Deno Rate Limit driver."),
      dev: native("memory", "memory", "Process-local memory driver for development and tests.", "process-local"),
      netlify: unsupported("ViteHub has no native Netlify Rate Limit driver."),
      node: native("memory", "memory, or KV", "Without KV, each process counts alone. With KV on, ViteHub selects the kv provider, which shares the counts when KV uses Redis or a Postgres Database.", "process-local"),
      vercel: unsupported("ViteHub has no native Vercel Rate Limit driver."),
    },
    id: "rateLimit",
    packages: ["@vite-hub/rate-limit"],
    service: "rateLimit",
    summary: "Rate limits in `server/rate-limits/` that protect routes and Agent tools.",
    title: "Rate Limit",
  }),
  realtime: feature({
    definition: starter("server/realtime", name => `import { defineRealtime } from "vite-hub/realtime"

export default defineRealtime({
  auth: true,
  document: { workspace: "${name}" },
})
`),
    developmentOverrides: ["cloudflare", "deno", "netlify", "vercel"],
    docs: "/docs/realtime",
    enabledByDiscovery: ["realtime"],
    hosts: {
      cloudflare: native("cloudflare", "Durable Objects", "Cloudflare Durable Objects run the production rooms."),
      deno: unsupported("Realtime has no distributed Deno driver, and process memory is rejected for the Deno host."),
      dev: native("memory", "memory", "Process-memory driver for local development.", "process-local"),
      netlify: unsupported("Realtime has no distributed Netlify driver, and process memory is rejected for the Netlify host."),
      node: native("node", "Postgres or Redis", "Each instance keeps its rooms in memory and shares them through Redis with REDIS_URL, else Postgres on a Postgres Default Database. Without either, rooms stay in one process."),
      vercel: unsupported("Realtime has no distributed Vercel driver, and process memory is rejected for the Vercel host."),
    },
    id: "realtime",
    packages: ["@vite-hub/realtime"],
    service: "realtime",
    summary: "Shared rooms with presence and Yjs documents.",
    title: "Realtime",
  }),
  sandboxTask: feature({
    docs: "/docs/sandbox",
    hosts: {
      cloudflare: native("cloudflare", "CF Sandbox", "Cloudflare Sandbox execution provider."),
      deno: unsupported("No Deno Sandbox driver is provided."),
      dev: unsupported("The default Node host has no Sandbox Provider. Development with the Vercel host uses Vercel Sandbox when Vercel credentials are set. The Vite or Nuxt dev server cannot host a Cloudflare Container: build, then run `wrangler dev` on the build output."),
      netlify: explicit("sandboxTask.driver", "Vercel Sandbox", "The Netlify host has no Sandbox, so `sandboxTask: true` fails. Set `sandboxTask: { driver: \"vercel\" }` and Vercel credentials to use Vercel Sandbox."),
      node: explicit("sandboxTask.driver", "Vercel Sandbox", "The Node host has no Sandbox, so `sandboxTask: true` fails. Set `sandboxTask: { driver: \"vercel\" }` and Vercel credentials to use Vercel Sandbox."),
      vercel: native("vercel", "Vercel Sandbox", "Vercel Sandbox execution provider."),
    },
    id: "sandboxTask",
    packages: ["@vite-hub/sandbox"],
    service: "sandbox",
    summary: "Sandbox Tasks in `server/sandbox-tasks/`. Each run starts an isolated Cloudflare or Vercel Sandbox.",
    title: "Sandbox",
  }),
  schedule: feature({
    definition: starter("server/schedules", name => `import { defineSchedule } from "vite-hub/schedule"

export default defineSchedule({
  cron: "0 * * * *",
  handler: () => {
    console.log("${name}")
  },
})
`, { suffix: "schedule" }),
    developmentOverrides: ["cloudflare", "netlify", "vercel"],
    docs: "/docs/schedule",
    enabledByDiscovery: ["schedules"],
    hosts: {
      cloudflare: native("cloudflare", "Cron triggers", "Cloudflare scheduled events and Nitro Provider Wake."),
      deno: native("deno", "Deno.cron", "`Deno.cron` output that the generated `.output/main.ts` loads before the Nitro server."),
      dev: native("local", "Local / process", "Local development runner and the explicit process runtime.", "single-host"),
      netlify: native("netlify", "Scheduled fn", "One generated Netlify scheduled function per static Schedule."),
      node: native("process", "process", "Process runtime for one long-lived process or replica. `schedule: true` uses it. Set `providerOutput: false` to wake Schedules yourself.", "single-host"),
      vercel: native("vercel", "Vercel Cron", "Vercel Cron Jobs provider output."),
    },
    id: "schedule",
    packages: ["@vite-hub/schedule"],
    summary: "Cron Schedules in `server/schedules/` that run on the host's scheduler.",
    title: "Schedule",
  }),
  workflow: feature({
    definition: starter("server/workflows", name => `import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow(${JSON.stringify(name)}, async (payload: { id: string }) => {
  return { id: payload.id }
})
`, { folder: "index", suffix: "workflow" }),
    docs: "/docs/workflows",
    enabledByDiscovery: ["workflows"],
    hosts: {
      cloudflare: native("cloudflare", "CF Workflows", "Cloudflare Workflows provider."),
      deno: explicit("workflow.driver", "OpenWorkflow", "Set `workflow.driver` to \"openworkflow\" with `workflow.postgres.url`, and start its worker. A build without a driver fails."),
      dev: native("openworkflow", "OpenWorkflow", "The Node host runs OpenWorkflow and its worker in the dev server, on .vitehub/data/openworkflow.sqlite.db. workflow.remote lets it use the Postgres Default Database or OPENWORKFLOW_POSTGRES_URL."),
      netlify: explicit("workflow.driver", "OpenWorkflow", "Use OpenWorkflow explicitly. No Netlify-native Workflow driver is provided."),
      node: {
        ...native("openworkflow", "OpenWorkflow", "OpenWorkflow is the default, and each server runs its worker. It uses OPENWORKFLOW_POSTGRES_URL or the Postgres Default Database. Without them, runs use a SQLite file on one host.", "single-host"),
        envOverrides: ["OPENWORKFLOW_POSTGRES_URL"].map(env => ({
          env,
          support: native("openworkflow", "OpenWorkflow (Postgres)", `${env} selects Postgres. Several servers can run the worker on the same database, and each run executes once.`),
        })),
      },
      vercel: native("vercel", "Vercel Workflow", "Vercel Workflow provider and Workflow DevKit output."),
    },
    id: "workflow",
    packages: ["@vite-hub/workflow"],
    summary: "Durable Workflows in `server/workflows/` with steps and driver retries.",
    title: "Workflow",
  }),
  workspace: feature({
    developmentOverrides: ["cloudflare", "deno", "netlify", "vercel"],
    docs: "/docs/workspace",
    enabledByDiscovery: ["workspaces"],
    hosts: {
      cloudflare: native("memory", "Artifacts / GitHub", "Memory by default, or Cloudflare Artifacts beta and GitHub for durable state.", "process-local"),
      deno: explicit("workspace.store", "GitHub", "Select the GitHub Workspace Store explicitly for durable state."),
      dev: native("local", "local / memory", "Local filesystem or in-memory Workspace Store.", "single-host"),
      netlify: explicit("workspace.store", "GitHub", "Select the GitHub Workspace Store explicitly for durable state."),
      node: native("local", "local / GitHub", "Local filesystem, memory, or GitHub Workspace Store.", "single-host"),
      vercel: {
        ...native("memory", "memory / Blob / GitHub", "Process-local memory by default. BLOB_READ_WRITE_TOKEN selects Vercel Blob; GitHub can be selected explicitly for durable state.", "process-local"),
        envOverrides: [{
          env: "BLOB_READ_WRITE_TOKEN",
          support: native("vercel", "Blob / GitHub", "BLOB_READ_WRITE_TOKEN selects durable Vercel Blob storage by default."),
        }],
      },
    },
    id: "workspace",
    packages: ["@vite-hub/workspace"],
    summary: "File workspaces that Agents read and edit, backed by local, Blob, or GitHub stores.",
    title: "Workspace",
  }),
}

/** Packages needed by a feature, its provider, and its enabled feature integrations. */
export function featurePackages(id: FeatureId, value: unknown, host: ViteHubHost | "unknown", enabled: readonly FeatureId[] = []): string[] {
  const definition = features[id]
  const options = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  const stores = options?.stores
  const values = id === "blob" && stores && typeof stores === "object" && !Array.isArray(stores)
    ? [value, ...Object.values(stores)]
    : [value]
  const selected = values.flatMap(value => Object.entries(definition.providerPackages ?? {}).flatMap(([key, choices]) => {
    const choice: unknown = value && typeof value === "object" && !Array.isArray(value) ? Reflect.get(value, key) : undefined
    return typeof choice === "string" ? choices[choice] ?? [] : []
  }))
  // `observability.service` installs `useObservability()`, which `@vite-hub/agent` provides.
  if (id === "observability" && typeof options?.service === "string") selected.push("@vite-hub/agent")
  if (id === "observability" && options?.posthog) selected.push("posthog-node")
  // A Sandbox Task loads its driver SDK at build time (Cloudflare) or at run time (Vercel). An explicit `driver` wins over the host's.
  const sandboxDriver = typeof options?.driver === "string" ? options.driver : host
  if (id === "sandboxTask" && (sandboxDriver === "vercel" || sandboxDriver === "cloudflare")) selected.push(sandboxDriverPackages[sandboxDriver])
  // On Vercel, Queue and Workflow use the Vercel driver unless the app sets another `driver`.
  if ((id === "queue" || id === "workflow") && host === "vercel" && (options?.driver ?? "vercel") === "vercel") selected.push(...vercelProviderPackages[id])
  if (id === "console" && enabled.includes("agent")) selected.push(...consoleFeaturePackages.agents)
  return [...new Set([...definition.packages, ...selected])]
}

const sandboxDriverPackages = { cloudflare: "@cloudflare/sandbox", vercel: "@vercel/sandbox" } as const

/**
 * The SDKs of the Vercel provider. Native Vercel Workflows also need `workflow` and `@workflow/builders`, but only
 * `@vite-hub/workflow` knows when a Workflow is native, so it checks those two itself.
 */
const vercelProviderPackages = {
  queue: ["@vercel/queue", "@vercel/functions"],
  workflow: ["@vercel/functions"],
} as const

/** Additional Console owners selected by its enabled Agent integration. */
export const consoleFeaturePackages = {
  agents: ["@libsql/client", "drizzle-orm"],
} as const

/** How `host` supports `id`. Development requires the app's configured (or detected) ViteHub host. */
export function featureSupport(id: FeatureId, host: ViteHubHost): HostSupport
export function featureSupport(id: FeatureId, host: FeatureHost, appHost: ViteHubHost): HostSupport
export function featureSupport(id: FeatureId, host: FeatureHost, appHost?: ViteHubHost): HostSupport {
  const definition = features[id]
  if (host !== "dev") return definition.hosts[host]
  invariant(appHost, "every caller of featureSupport() for the dev host passes the configured ViteHub host")
  if (id === "workflow" && appHost === "deno") return native("vercel", "Inline", "Development runs each Workflow inline unless OpenWorkflow storage or a provider is configured.", "process-local")
  return definition.hosts[appHost === "node" || definition.developmentOverrides?.includes(appHost) ? "dev" : appHost]
}

/**
 * The features that `enabled` turn on through implications, without the ones already in `enabled`.
 * This follows implications transitively.
 * `disabled` lists features that the app sets to `false`; an implication never turns them on.
 */
export function impliedFeatures(enabled: readonly FeatureId[], disabled: readonly FeatureId[] = []): FeatureId[] {
  const on = new Set(enabled)
  const implied: FeatureId[] = []
  const pending = [...enabled]
  while (pending.length) {
    const id = pending.shift()!
    for (const implication of features[id].implies) {
      if (on.has(implication.feature) || disabled.includes(implication.feature)) continue
      on.add(implication.feature)
      implied.push(implication.feature)
      pending.push(implication.feature)
    }
  }
  return implied
}
