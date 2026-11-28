import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { flattenPluginOptions } from "@vite-hub/internal/contributions"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveDurabilityModule } from "@vite-hub/internal/durability"
import { sqliteUrlInput } from "@vite-hub/runtime/durability"
import { ownModule } from "@vite-hub/internal/build/paths"
import { isProductionBuild, resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { isDefaultAgentJournal } from "./agent-invocations-setting.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { requireOptionalOwner } from "./internal/optional-owners.ts"
import { ownerModules } from "./internal/owner-modules.ts"

import type { Plugin } from "vite"
import type { AgentInvocationsDurabilityInput } from "@vite-hub/agent/durability"
import type { DurabilityPluginMetadata } from "@vite-hub/internal/durability"
import type { AgentRetentionPolicy } from "@vite-hub/agent/server"
import type { AgentInvocationsDefault } from "@vite-hub/agent"
import type { DatabaseContributionContext, DatabaseContributionEntry, DBVitePlugin } from "@vite-hub/database/vite"

const agentInvocationsLibsqlModule = ownModule(import.meta.url, "internal/agent-invocations-libsql")

const generatedAgentInvocationsPlugin = ".vitehub/nitro/agent/invocations.mjs"
const agentInvocationsPluginName = "vite-hub/agent-invocations"

/**
 * Vite config key with the store of the default journal that a host framework resolved, such as Nuxt from its rootDir
 * and replayed Database configuration. An undefined binding means none. It wins over `resolveD1Binding`.
 */
export const VITEHUB_AGENT_JOURNAL_STORE = "__vitehubAgentJournalStore" as const

/** The value of `VITEHUB_AGENT_JOURNAL_STORE`. */
export interface AgentJournalHostStore {
  d1?: string
}

export interface AgentInvocationsRenderOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The D1 binding of the default journal in a Cloudflare production build. */
  d1Binding?: string
  /** The Database of the default journal in a Node production build whose default Database uses Postgres. */
  journalDatabase?: string
  /**
   * Load the libSQL driver of the default journal. Defaults to true. A Cloudflare production build without
   * `databaseUrl` sets false, because its journal is D1 or memory: see `defaultJournalNeedsLibsql()`.
   */
  libsql?: boolean
  /** The ViteHub project root of the default journal. Without it, the plugin installs no default journal. */
  projectRoot?: string
  /** The `file:` Agent State URL that the default journal goes next to. See `agentJournalStateUrl()`. */
  stateUrl?: string
}

export interface AgentInvocationsPluginOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The deployment host. A production build for a host without a persistent filesystem warns about the local file. */
  host?: string
  /** The D1 binding of the default Database Definition on Cloudflare. A production build stores the default journal there. */
  resolveD1Binding?: (root: string, serverDirs: string[] | undefined) => string | undefined
  /** The `file:` Agent State URL that the default journal goes next to. See `agentJournalStateUrl()`. */
  stateUrl?: string
}

const hostsWithoutPersistentFiles = new Set(["deno", "netlify", "vercel"])

function journalStorageWarning(options: { build: boolean, d1Binding?: string, databaseUrl?: string, host?: string }): string | undefined {
  if (!options.build || options.databaseUrl) return
  if (options.host === "cloudflare" && !options.d1Binding) {
    return "[vitehub] Agent Invocation journal: this Cloudflare build has no Database, so the default journal keeps records in the memory of the Worker isolate and loses them when the isolate stops. Set `database: true` in `vitehub()` to keep them in D1, or set agent.invocations.databaseUrl to a remote libSQL URL."
  }
  if (hostsWithoutPersistentFiles.has(options.host ?? "")) {
    return `[vitehub] Agent Invocation journal: the ${options.host} host has no persistent filesystem, so the default journal file .vitehub/data/agent-invocations.sqlite does not keep records. Set agent.invocations to "database", or set agent.invocations.databaseUrl to a remote libSQL URL.`
  }
}

/**
 * Validates `agent.invocations.retention` before code generation. Only a local SQLite journal supports maxSize.
 * D1 reports the size of the whole app database, a ViteHub Database holds other tables, and remote libSQL does not
 * report file size. `store` is the D1 binding or the Database that keeps the default journal.
 */
export function assertAgentInvocationsRetention(retention: AgentRetentionPolicy | undefined, store: { d1?: string, database?: string }, databaseUrl?: string): void {
  if (retention === undefined) return
  const { maxSize } = requireOptionalOwner(ownerModules.agentVite, "agent").normalizeRetention(retention, {
    label: "agent.invocations.retention",
    defaults: { maxAgeMs: false, maxRecords: false, maxSize: false },
    size: "any",
    error: message => viteHubErrorDiagnostics.VITE_HUB_B0015({ message: `[vitehub] ${message}` }),
  })
  if (maxSize !== false && store.database) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0016({ message: `[vitehub] agent.invocations.retention.maxSize is not supported by the journal in the ${store.database} Database, because the Database holds other tables. Use maxAge or maxRecords, or set agent.invocations.databaseUrl to a SQLite file.` })
  }
  if (maxSize !== false && store.d1) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0016({ message: "[vitehub] agent.invocations.retention.maxSize is not supported by the D1 journal, because D1 reports the size of the whole app database. Use maxAge or maxRecords, or set agent.invocations.databaseUrl to a SQLite file." })
  }
  if (maxSize !== false && databaseUrl && !/^file:/i.test(databaseUrl)) {
    throw viteHubErrorDiagnostics.VITE_HUB_B0016({ message: "[vitehub] agent.invocations.retention.maxSize needs a local SQLite file. Remote libSQL databases do not support it. Use maxAge or maxRecords, or set agent.invocations.databaseUrl to a SQLite file." })
  }
}

/** A Worker cannot open a local file, so a Cloudflare production build rejects a `file:` journal URL instead of keeping records in memory. */
export function assertAgentInvocationsUrl(host: string | undefined, databaseUrl: string | undefined): void {
  if (host !== "cloudflare" || !databaseUrl || !/^file:/i.test(databaseUrl.trim())) return
  throw viteHubErrorDiagnostics.VITE_HUB_B0021({ message: "[vitehub] agent.invocations.databaseUrl is a local file, which a Cloudflare Worker cannot open. Remove it to use the D1 binding of the default Database, or set a remote libSQL URL." })
}

/**
 * Whether a default journal can select SQLite or libSQL, so the generated server must load the libSQL driver.
 * A Cloudflare production build stores it in D1 or Worker memory unless `databaseUrl` selects libSQL. Development
 * keeps the local file. `VITEHUB_AGENT_INVOCATIONS_DATABASE_URL` on such a Worker then throws `AGENT_R1036`.
 */
export function defaultJournalNeedsLibsql(options: { build: boolean, databaseUrl?: string, host?: string }): boolean {
  return !options.build || options.host !== "cloudflare" || Boolean(options.databaseUrl?.trim())
}

/** Render the Nitro plugin that installs the Database store loader and the app-wide journal before Agents run. */
export function renderAgentInvocationsNitroPlugin(options: AgentInvocationsRenderOptions): string {
  const journal = options.projectRoot !== undefined && isDefaultAgentJournal(options.default)
    ? [
        `projectRoot: ${JSON.stringify(options.projectRoot)}`,
        ...(options.d1Binding ? [`d1: { binding: ${JSON.stringify(options.d1Binding)}, env: async () => (await import("cloudflare:workers")).env }`] : []),
        ...(options.journalDatabase ? [`database: ${JSON.stringify(options.journalDatabase)}`] : []),
        ...(options.libsql === false ? [] : [`libsql: () => import(${JSON.stringify(agentInvocationsLibsqlModule)})`]),
        ...(options.stateUrl ? [`stateUrl: ${JSON.stringify(options.stateUrl)}`] : []),
      ]
    : []
  const settings = [
    ...(options.database ? [`database: () => import("vite-hub/agent/invocations/database")`] : []),
    ...(options.default !== undefined && options.default !== false ? [`default: ${JSON.stringify(options.default)}`] : []),
    ...(journal.length ? [`journal: { ${journal.join(", ")} }`] : []),
  ]
  return [
    `import { installAgentInvocations } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@vite-hub/agent/invocations/app")))}`,
    "",
    `installAgentInvocations({ ${settings.join(", ")} })`,
    "",
    "export default function viteHubAgentInvocationsPlugin() {}",
    "",
  ].join("\n")
}

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

/** Write the generated Agent Invocations Nitro plugin of a project. Returns its path. */
export async function writeAgentInvocationsNitroPlugin(options: AgentInvocationsRenderOptions & { projectRoot: string }): Promise<string> {
  const plugin = resolve(options.projectRoot, generatedAgentInvocationsPlugin)
  await writeIfChanged(plugin, renderAgentInvocationsNitroPlugin(options))
  return plugin
}

function journalDurabilityInput(setting: AgentInvocationsDefault | undefined, store: { d1?: string, database?: string }, stateUrl: string | undefined): AgentInvocationsDurabilityInput | undefined {
  if (setting === false) return
  if (setting === "memory" || (typeof setting === "object" && setting.store === "memory")) return { store: "memory" }
  if (setting === "database") return { store: "database" }
  if (typeof setting === "object" && setting.store === "database") return { store: "database", ...(setting.database ? { database: setting.database } : {}) }
  if (store.d1) return { store: "d1" }
  if (store.database) return { store: "database", database: store.database, defaultJournal: true }
  const databaseUrl = typeof setting === "object" && "databaseUrl" in setting && typeof setting.databaseUrl === "string" ? setting.databaseUrl : undefined
  return { store: "file", ...(databaseUrl ? { url: sqliteUrlInput(databaseUrl) } : stateUrl ? { stateUrl } : {}) }
}

/**
 * The Postgres journal tables for the Database that `invocations: 'database'` uses: the Database of
 * `agent.invocations`, else `default`. A Postgres Database gets them from its migrations, because the store does not
 * create tables. This includes the implicit `default` Database when other contributions make it use Postgres.
 * SQLite, libSQL, and D1 get nothing here: the store creates its table on first use.
 */
export async function agentInvocationsDatabaseContributions(context: DatabaseContributionContext, setting: AgentInvocationsDefault | undefined, host?: string): Promise<DatabaseContributionEntry[]> {
  const database = (typeof setting === "object" && "store" in setting && setting.store === "database" ? setting.database : undefined) ?? "default"
  const { discoverDatabaseDefinitions, readDatabaseDefinitionDialect } = requireOptionalOwner(ownerModules.databaseConfig, "database")
  const { collectDatabaseContributions } = requireOptionalOwner(ownerModules.databaseVite, "database")
  const plugins = (await flattenPluginOptions(context.plugins)).filter(plugin => Reflect.get(plugin, "name") !== agentInvocationsPluginName)
  const contributions = await collectDatabaseContributions(plugins, { ...context, plugins })
  const target = discoverDatabaseDefinitions(context.rootDir, { contributions, serverDirs: context.serverDirs?.slice() }).find(definition => definition.name === database)
  if (!target || readDatabaseDefinitionDialect(target.handler) !== "postgresql") return []
  const entries: DatabaseContributionEntry[] = [{
    name: "agent-invocations",
    database,
    dialect: "postgresql",
    definition: { module: "vite-hub/agent/invocations/postgres", export: "agentInvocationsPostgresSchema" },
    tables: {
      agentInvocations: "vitehub_agent_invocations",
      agentInvocationObservations: "vitehub_agent_invocations_observations",
      agentChatStreams: "vitehub_agent_chat_streams",
      agentChatStreamChunks: "vitehub_agent_chat_stream_chunks",
    },
    reason: "Stores the Agent Invocations of `invocations: 'database'`, and the streams of web chat routes with `resumable.scope: 'shared'`. The journal does not create its tables on Postgres.",
  }]
  if (host === "node" && isDefaultAgentJournal(setting) && !setting?.databaseUrl) {
    entries.push({
      name: "agent-default-journal",
      database,
      dialect: "postgresql",
      definition: { module: "vite-hub/agent/invocations/postgres", export: "agentDefaultJournalPostgresSchema" },
      tables: { agentDefaultInvocations: "vitehub_default_agent_invocations", agentDefaultInvocationObservations: "vitehub_default_agent_invocations_observations" },
      reason: "Stores the default Agent Invocation journal of a Node build separately from explicit journals.",
    })
  }
  return entries
}

/**
 * Register a generated Nitro plugin that installs the Agent Invocation journal before other plugins.
 * Without an `agent.invocations` store, it installs the default journal, with the Console on or off.
 */
export function agentInvocationsVitePlugin(options: AgentInvocationsPluginOptions): Plugin & { vitehub: DurabilityPluginMetadata & { databases: (context: DatabaseContributionContext) => Promise<DatabaseContributionEntry[]> } } {
  let d1Binding: string | undefined
  let journalDatabase: string | undefined
  let postgresJournalRoot: string | undefined
  let libsql = true
  let storageWarning: string | undefined
  return {
    name: agentInvocationsPluginName,
    vitehub: {
      databases: async context => options.database ? await agentInvocationsDatabaseContributions(context, options.default, options.host) : [],
      durability: () => {
        const input = journalDurabilityInput(options.default, { d1: d1Binding, database: journalDatabase }, options.stateUrl)
        if (!input) return []
        const module = resolveDurabilityModule(import.meta.url, "@vite-hub/agent/durability")
        return [
          { export: "agentInvocationsDurability", input, module, primitive: "agent-invocations" },
          { export: "agentChatStreamsDurability", input, module, primitive: "agent-chat-streams" },
        ]
      },
    },
    async config(config, environment) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_AGENT_JOURNAL_STORE]?: AgentJournalHostStore, [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], nitro?: Record<string, unknown> }
      const root = config.root || process.cwd()
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(root)
      const setting = options.default
      journalDatabase = undefined
      postgresJournalRoot = undefined
      if (isDefaultAgentJournal(setting)) {
        const hostStore = viteConfig[VITEHUB_AGENT_JOURNAL_STORE]
        const build = environment?.command === "build" && !setting?.databaseUrl
        const serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
        d1Binding = build ? hostStore ? hostStore.d1 : options.resolveD1Binding?.(root, serverDirs) : undefined
        if (build && options.database && options.host === "node") postgresJournalRoot = projectRoot
        if (!postgresJournalRoot) assertAgentInvocationsRetention(setting?.retention, { d1: d1Binding }, setting?.databaseUrl)
        libsql = defaultJournalNeedsLibsql({ build: environment?.command === "build", databaseUrl: setting?.databaseUrl, host: options.host })
        if (isProductionBuild(config, environment)) assertAgentInvocationsUrl(options.host, setting?.databaseUrl)
        storageWarning = journalStorageWarning({ build: environment?.command === "build", d1Binding, databaseUrl: setting?.databaseUrl, host: options.host })
      }
      else {
        d1Binding = undefined
        libsql = true
        storageWarning = undefined
      }
      const plugin = await writeAgentInvocationsNitroPlugin({ database: options.database, d1Binding, default: options.default, journalDatabase, libsql, projectRoot, stateUrl: options.stateUrl })
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin, "start")
      viteConfig.nitro = kit.config
    },
    async configResolved(config) {
      if (postgresJournalRoot && isDefaultAgentJournal(options.default)) {
        const owner = config.plugins?.find((plugin): plugin is DBVitePlugin => plugin.name === "@vite-hub/database/vite")
        await owner?.api.whenConfigResolved?.()
        journalDatabase = owner?.api.getConfig()?.databases.default?.dialect === "postgresql" ? "default" : undefined
        assertAgentInvocationsRetention(options.default?.retention, { database: journalDatabase })
        if (journalDatabase) {
          await writeAgentInvocationsNitroPlugin({ database: true, default: options.default, journalDatabase, libsql, projectRoot: postgresJournalRoot, stateUrl: options.stateUrl })
        }
      }
      if (storageWarning) config.logger?.warn(storageWarning)
      if (d1Binding) config.logger?.info(`[vitehub] Agent Invocation journal: D1 binding ${d1Binding}, table vitehub_agent_invocations. The journal creates the table on first use.`)
      if (journalDatabase) config.logger?.info(`[vitehub] Agent Invocation journal: the Postgres ${journalDatabase} Database. Its migrations create the journal tables.`)
    },
  }
}
