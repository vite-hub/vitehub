import type { DeploymentPreset, DeploymentService } from "./deployment.ts"

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
  "kv",
  "logs",
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

/** `dev` stores default Node development support. Use `featureSupport()` with the configured preset for development lookups. */
export const featureHosts = ["dev", "cloudflare", "vercel", "netlify", "deno", "node"] as const
export type FeatureHost = (typeof featureHosts)[number]

export interface NativeHostSupport {
  level: "native"
  /** The default provider or adapter that ViteHub selects, such as `cloudflare-r2`. */
  adapter: string
  /** Short provider name for tables, such as `R2`. */
  display: string
  guarantee: "native" | "single-host" | "process-local"
  detail: string
  /** The first override whose environment variable has a non-empty, trimmed value replaces the default. */
  envOverrides?: readonly { env: string, support: Omit<NativeHostSupport, "envOverrides"> }[]
}

/**
 * How a host supports a feature when the app enables it in `vitehub({...})`.
 * - `native`: ViteHub selects a provider for the host. Credentials can still be needed.
 * - `explicit`: the app must set `option` to choose a provider.
 * - `unsupported`: `vitehub({...})` cannot provide the feature on this host.
 */
export type HostSupport
  = | NativeHostSupport
  | {
    level: "explicit"
    display: string
    /** The option path that selects a provider, such as `blob.driver`. */
    option: `${FeatureId}.${string}`
    detail: string
  }
  | { level: "unsupported", detail: string }

/** A feature that this feature turns on, unless the app sets the other feature to `false`. */
export interface FeatureImplication {
  feature: FeatureId
  /** Presets where the implication does not apply. */
  except?: readonly DeploymentPreset[]
}

/** The starter Definition file that `vitehub add <feature> --name <name>` creates. */
export interface FeatureStarter {
  /** The folder of the Definitions, relative to the project root, such as `server/queues`. */
  dir: string
  /** The path of the Definition `name`, relative to the project root. */
  file: (name: string) => string
  /** The source of a minimal Definition named `name`. */
  template: (name: string) => string
}

export interface FeatureDefinition<TId extends FeatureId = FeatureId> {
  id: TId
  title: string
  /** One sentence for pickers and docs. */
  summary: string
  docs: `/docs/${string}`
  /** Whether the feature is unconditionally on when the app does not set its key. */
  enabledByDefault: boolean
  /** File names in the configured server directories (default `server/`) that enable an unset feature. `false` disables discovery. */
  enabledByDiscovery?: readonly string[]
  /** Packages that the app installs for this feature, in `pnpm add` order. */
  packages: readonly string[]
  /** Development dependencies that the app installs for this feature. */
  devPackages: readonly string[]
  implies: readonly FeatureImplication[]
  /** The Deployment Plan service that this feature reads, when it has one. */
  service?: DeploymentService
  hosts: Readonly<Record<FeatureHost, HostSupport>>
  /** The starter Definition, for features with Definition files. */
  definition?: FeatureStarter
  /** Presets that use `hosts.dev` during development instead of their deployment entry. Node always uses `hosts.dev`. */
  developmentOverrides?: readonly DeploymentPreset[]
}

const noHostLimit = "No host limit in ViteHub."

function native(adapter: string, display: string, detail: string, guarantee: "native" | "single-host" | "process-local" = "native"): NativeHostSupport {
  return { adapter, detail, display, guarantee, level: "native" }
}

function explicit(option: `${FeatureId}.${string}`, display: string, detail: string): HostSupport {
  return { detail, display, level: "explicit", option }
}

function unsupported(detail: string): HostSupport {
  return { detail, level: "unsupported" }
}

function everywhere(adapter: string, display: string, detail = noHostLimit): Record<FeatureHost, HostSupport> {
  const support = native(adapter, display, detail)
  return { cloudflare: support, deno: support, dev: support, netlify: support, node: support, vercel: support }
}

function feature<TId extends FeatureId>(definition: Omit<FeatureDefinition<TId>, "devPackages" | "enabledByDefault" | "implies" | "packages"> & Partial<Pick<FeatureDefinition<TId>, "devPackages" | "enabledByDefault" | "implies" | "packages">>): FeatureDefinition<TId> {
  return { devPackages: [], enabledByDefault: false, implies: [], packages: [], ...definition }
}

/** A starter for Definitions in `dir`, one `<name>.ts` file each. */
function starter(dir: string, template: (name: string) => string): FeatureStarter {
  return { dir, file: name => `${dir}/${name}.ts`, template }
}

export const features: { readonly [K in FeatureId]: FeatureDefinition<K> } = {
  agent: feature({
    definition: starter("server/agents", name => `import { defineAgent } from "vite-hub/agent"

export default defineAgent({
  driver: { run: () => ({ text: "Hello from ${name}." }) },
})
`),
    docs: "/docs/agents",
    hosts: {
      ...everywhere("nitro", "Nitro"),
      deno: native("nitro", "Nitro", "Agent routes run in the Nitro output. The Agent Deno runtime is not supported on this preset."),
      netlify: native("nitro", "Nitro", "Agent HTTP routes run in generated functions. `agent.invocations` is not supported."),
    },
    id: "agent",
    implies: [{ except: ["netlify"], feature: "workflow" }],
    packages: ["@vite-hub/agent"],
    summary: "Agents in `server/agents/` with tools, Capabilities, channels, and invocations.",
    title: "Agent",
  }),
  auth: feature({
    docs: "/docs/auth",
    hosts: everywhere("better-auth", "Better Auth"),
    id: "auth",
    packages: ["@vite-hub/auth", "better-auth"],
    summary: "Better Auth sign-in, sessions, and organizations, with tables that ViteHub owns.",
    title: "Auth",
  }),
  blob: feature({
    docs: "/docs/blob",
    hosts: {
      cloudflare: native("cloudflare-r2", "R2", "Cloudflare R2 binding or S3-compatible HTTP access."),
      deno: explicit("blob.driver", "S3", "Use a remote S3-compatible store. No Deno-native Blob driver is provided."),
      dev: native("fs", "fs", "Local filesystem storage for development.", "single-host"),
      netlify: native("netlify-blobs", "Netlify Blobs", "Netlify Blobs selected from the detected host."),
      node: native("fs", "fs / S3", "Filesystem, S3-compatible, MinIO, or files-sdk drivers.", "single-host"),
      vercel: native("vercel-blob", "Vercel Blob", "Vercel Blob through the vercel-blob driver."),
    },
    id: "blob",
    service: "blob",
    summary: "Object storage for files and uploads, with one API on every host.",
    title: "Blob",
  }),
  browser: feature({
    docs: "/docs/browser",
    hosts: {
      cloudflare: native("cloudflare", "Browser Run", "Cloudflare Browser Run binding and provider output."),
      deno: unsupported("Browser Definitions do not have a Deno provider."),
      dev: unsupported("Browser Definitions need the Cloudflare preset. Use createBrowser({ provider: localBrowser({ executablePath }) }) from code for a trusted local process."),
      netlify: unsupported("Browser Definitions do not have a Netlify provider."),
      node: unsupported("The Node preset has no built-in Browser Provider. Use localBrowser() from code for a trusted process."),
      vercel: unsupported("Browser Definitions do not have a Vercel provider."),
    },
    id: "browser",
    service: "browser",
    summary: "Headless browser sessions for Agents and server code.",
    title: "Browser",
  }),
  cache: feature({
    developmentOverrides: ["cloudflare", "deno", "vercel"],
    docs: "/docs/reference/config-options",
    hosts: {
      cloudflare: native("cloudflare-kv-binding", "Workers KV", "Workers KV binding `CACHE`."),
      deno: native("deno-kv", "Deno KV", "Native Deno KV."),
      dev: native("fs-lite", "fs-lite", "`.vitehub/data/cache` during development.", "single-host"),
      netlify: explicit("cache.driver", "KV", "`cache: true` has no default store on Netlify. Set `cache: { driver: \"kv\" }` and enable `kv`."),
      node: native("fs-lite", "fs-lite", "`.vitehub/data/cache` on the server disk.", "single-host"),
      vercel: native("vercel-runtime-cache", "Runtime Cache", "Vercel Runtime Cache."),
    },
    id: "cache",
    summary: "Storage for Nitro's cache mount, used by defineCachedFunction() and defineCachedEventHandler().",
    title: "Cache",
  }),
  channels: feature({
    docs: "/docs/channels",
    hosts: everywhere("nitro", "Nitro"),
    id: "channels",
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
    hosts: everywhere("database", "Database"),
    id: "connections",
    implies: [{ feature: "database" }],
    packages: ["@vite-hub/database", "drizzle-orm"],
    summary: "OAuth and API key Connections in `server/connections/`, with grants stored in a Database.",
    title: "Connections",
  }),
  console: feature({
    docs: "/docs/development/console",
    hosts: everywhere("nitro", "Nitro"),
    id: "console",
    implies: [{ feature: "comments" }],
    summary: "The ViteHub Console at `/_vitehub` to inspect and operate every primitive.",
    title: "Console",
  }),
  database: feature({
    definition: {
      dir: "server/databases",
      file: name => name === "default" ? "server/databases/config.ts" : `server/databases/${name}/config.ts`,
      template: () => `import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { defineDatabase } from "vite-hub/database"

export default defineDatabase({
  schema: {
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
      cloudflare: native("d1", "D1", "Cloudflare D1 binding, with authenticated HTTP available for development."),
      deno: explicit("database.connection", "libSQL", "Use a hosted libSQL connection. No Deno-native database driver is provided."),
      dev: native("sqlite", "SQLite", "Local SQLite through libSQL and Drizzle.", "single-host"),
      netlify: explicit("database.connection", "libSQL", "Use a hosted libSQL connection. No Netlify-native database driver is provided."),
      node: native("sqlite", "SQLite / libSQL", "SQLite or hosted libSQL through the selected Database connection.", "single-host"),
      vercel: explicit("database.connection", "libSQL / D1", "Configure hosted libSQL, D1 over authenticated HTTP, or a PostgreSQL Database Definition. The default local SQLite file is not supported in Vercel functions."),
    },
    id: "database",
    packages: ["@vite-hub/database", "drizzle-orm"],
    summary: "Drizzle Databases in `server/databases/` with migrations and a local SQLite in development.",
    title: "Database",
  }),
  email: feature({
    docs: "/docs/email",
    hosts: {
      cloudflare: native("cloudflare-email", "Cloudflare Email", "The Cloudflare Email driver is the default. Resend is also supported."),
      deno: explicit("email.driver", "Resend", "Configure the built-in fetch-based Resend driver."),
      dev: explicit("email.driver", "Resend", "Configure the built-in Resend driver for local delivery."),
      netlify: explicit("email.driver", "Resend", "Configure the built-in Resend driver."),
      node: explicit("email.driver", "Resend / custom", "Configure Resend or provide a custom ViteHub Email driver."),
      vercel: explicit("email.driver", "Resend", "Configure the built-in Resend driver."),
    },
    id: "email",
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
  kv: feature({
    developmentOverrides: ["netlify"],
    docs: "/docs/kv",
    hosts: {
      cloudflare: native("cloudflare-kv-binding", "Workers KV", "Cloudflare Workers KV binding."),
      deno: native("deno-kv", "Deno KV", "Native Deno KV through Deno.openKv()."),
      dev: native("fs-lite", "fs-lite", "Local filesystem-backed KV for development.", "single-host"),
      netlify: explicit("kv.driver", "Upstash", "Configure a remote Upstash store. No Netlify-native KV output is provided."),
      node: native("fs-lite", "fs-lite / Upstash", "Filesystem-backed KV or remote Upstash Redis.", "single-host"),
      vercel: native("upstash", "Upstash", "Upstash Redis with KV REST credentials."),
    },
    id: "kv",
    summary: "Key-value storage with one API on every host.",
    title: "KV",
  }),
  logs: feature({
    docs: "/docs/logs",
    hosts: everywhere("nitro", "Nitro"),
    id: "logs",
    summary: "Read an existing log source, or inspect a bounded Evlog buffer during development.",
    title: "Logs",
  }),
  observability: feature({
    docs: "/docs/agents/observability",
    hosts: everywhere("evlog", "Evlog"),
    id: "observability",
    packages: ["@vite-hub/agent"],
    summary: "Agent telemetry, request logs, and papercut reports through Evlog.",
    title: "Observability",
  }),
  queue: feature({
    definition: starter("server/queues", name => `import { defineQueue } from "vite-hub/queue"

export default defineQueue<{ id: string }>(async ({ payload }) => {
  console.log("${name}", payload.id)
})
`),
    docs: "/docs/queue",
    hosts: {
      cloudflare: native("cloudflare", "Queues", "Cloudflare Queues bindings and consumers."),
      deno: unsupported("No Deno Queue provider is provided."),
      dev: native("local", "Local provider", "The local provider stores jobs in .vitehub/data/queue and runs them in the dev server process.", "single-host"),
      netlify: unsupported("Netlify has no built-in Queue Provider with ViteHub's delivery contract, and `queue` has no provider option."),
      node: native("local", "Local provider", "The local provider runs jobs in the server process. Jobs survive a restart on the same disk, on one host.", "single-host"),
      vercel: native("vercel", "Vercel Queues", "Vercel Queues callbacks and runtime client."),
    },
    id: "queue",
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
      node: native("memory", "memory", "The memory driver is safe only for a single process.", "process-local"),
      vercel: unsupported("ViteHub has no native Vercel Rate Limit driver."),
    },
    id: "rateLimit",
    service: "rateLimit",
    summary: "Rate limits in `server/rate-limits/` that protect routes and Agent tools.",
    title: "Rate Limit",
  }),
  realtime: feature({
    definition: starter("server/realtime", name => `import { defineRealtime } from "vite-hub/realtime"

export default defineRealtime({
  document: { workspace: "${name}" },
})
`),
    developmentOverrides: ["cloudflare", "deno", "netlify", "vercel"],
    docs: "/docs/realtime",
    hosts: {
      cloudflare: native("cloudflare", "Durable Objects", "Cloudflare Durable Objects provide the production room authority."),
      deno: unsupported("Realtime has no distributed Deno authority, and process memory is rejected for the Deno preset."),
      dev: native("memory", "memory", "Process-memory authority for local development.", "process-local"),
      netlify: unsupported("Realtime has no distributed Netlify authority, and process memory is rejected for the Netlify preset."),
      node: explicit("realtime.authority", "memory", "Set `realtime: { authority: \"memory\" }` for a single-process server. A build without it has no room authority."),
      vercel: unsupported("Realtime has no distributed Vercel authority, and process memory is rejected for the Vercel preset."),
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
      deno: unsupported("No Deno Sandbox provider is provided."),
      dev: unsupported("The default Node preset has no Sandbox Provider. Development with the Cloudflare or Vercel preset uses that preset's Sandbox."),
      netlify: unsupported("The Netlify preset has no built-in isolated Sandbox Provider."),
      node: unsupported("The Node preset has no built-in isolated Sandbox Provider."),
      vercel: native("vercel", "Vercel Sandbox", "Vercel Sandbox execution provider."),
    },
    id: "sandboxTask",
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
`),
    developmentOverrides: ["cloudflare", "netlify", "vercel"],
    docs: "/docs/schedule",
    hosts: {
      cloudflare: native("cloudflare", "Cron triggers", "Cloudflare scheduled events and Nitro Provider Wake."),
      deno: unsupported("The generated cron output is not part of the deployed Nitro entrypoint. The standalone Schedule integration can generate Deno.cron output."),
      dev: native("local", "Local / process", "Local development runner and the explicit process runtime.", "single-host"),
      netlify: native("netlify", "Scheduled fn", "One generated Netlify scheduled function per static Schedule."),
      node: native("process", "process", "Process runtime for one long-lived process or replica. A build needs `schedule: { runtime: { driver: \"process\" } }`, or `providerOutput: false` to wake Schedules yourself.", "single-host"),
      vercel: native("vercel", "Vercel Cron", "Vercel Cron Jobs provider output."),
    },
    id: "schedule",
    packages: ["@vite-hub/schedule"],
    summary: "Cron Schedules in `server/schedules/` that run on the host's scheduler.",
    title: "Schedule",
  }),
  workflow: feature({
    definition: starter("server/workflows", () => `import { defineWorkflow } from "vite-hub/workflow"

export default defineWorkflow<{ id: string }>(async ({ payload }) => {
  return { id: payload.id }
})
`),
    docs: "/docs/workflows",
    hosts: {
      cloudflare: native("cloudflare", "CF Workflows", "Cloudflare Workflows provider."),
      deno: native("vercel", "Vercel Workflow", "Vercel Workflow is the default. Set workflow.provider explicitly to select OpenWorkflow."),
      dev: native("vercel", "Vercel Workflow", "The default Node preset selects Vercel Workflow. Node hosting selects OpenWorkflow when workflow.sqlite.path or workflow.postgres.url is configured."),
      netlify: explicit("workflow.provider", "OpenWorkflow", "Use OpenWorkflow explicitly. No Netlify-native Workflow provider is provided."),
      node: native("vercel", "Vercel Workflow", "Vercel Workflow is the default. Setting workflow.sqlite.path or workflow.postgres.url selects OpenWorkflow unless workflow.provider is explicit."),
      vercel: native("vercel", "Vercel Workflow", "Vercel Workflow provider and Workflow DevKit output."),
    },
    id: "workflow",
    summary: "Durable Workflows in `server/workflows/` with steps, sleeps, and retries.",
    title: "Workflow",
  }),
  workspace: feature({
    developmentOverrides: ["cloudflare", "deno", "netlify", "vercel"],
    docs: "/docs/workspace",
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
          support: native("vercel-blob", "Blob / GitHub", "BLOB_READ_WRITE_TOKEN selects durable Vercel Blob storage by default."),
        }],
      },
    },
    id: "workspace",
    packages: ["@vite-hub/workspace"],
    summary: "File workspaces that Agents read and edit, backed by local, Blob, or GitHub stores.",
    title: "Workspace",
  }),
}

/** How `host` supports `id`. Development requires the app's configured (or detected) deployment preset. */
export function featureSupport(id: FeatureId, host: DeploymentPreset): HostSupport
export function featureSupport(id: FeatureId, host: FeatureHost, preset: DeploymentPreset): HostSupport
export function featureSupport(id: FeatureId, host: FeatureHost, preset?: DeploymentPreset): HostSupport {
  const definition = features[id]
  if (host !== "dev") return definition.hosts[host]
  if (!preset) throw new Error("Development feature support requires the configured deployment preset.")
  return definition.hosts[preset === "node" || definition.developmentOverrides?.includes(preset) ? "dev" : preset]
}

/**
 * The features that `enabled` turn on through implications on `preset`, without the ones already in `enabled`.
 * Implications chain, so Console turns on Comments, which turns on Database.
 * `disabled` lists features that the app sets to `false`; an implication never turns them on.
 */
export function impliedFeatures(enabled: readonly FeatureId[], preset: DeploymentPreset, disabled: readonly FeatureId[] = []): FeatureId[] {
  const on = new Set(enabled)
  const implied: FeatureId[] = []
  const pending = [...enabled]
  while (pending.length) {
    const id = pending.shift()!
    for (const implication of features[id].implies) {
      if (implication.except?.includes(preset) || on.has(implication.feature) || disabled.includes(implication.feature)) continue
      on.add(implication.feature)
      implied.push(implication.feature)
      pending.push(implication.feature)
    }
  }
  return implied
}
