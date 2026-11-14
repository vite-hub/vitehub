import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

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

// Generated code imports this vite-hub module by path. It is not a package export.
const agentInvocationsLibsqlModule = ownModule(import.meta.url, "internal/agent-invocations-libsql")

const generatedAgentInvocationsPlugin = ".vitehub/nitro/agent/invocations.mjs"

/**
 * Vite config key with the D1 binding of the default journal that a host framework resolved, such as Nuxt from its
 * rootDir and replayed Database configuration. `binding: undefined` means no D1 binding. It wins over `resolveD1Binding`.
 */
export const VITEHUB_AGENT_JOURNAL_D1 = "__vitehubAgentJournalD1" as const

export interface AgentInvocationsRenderOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The D1 binding of the default journal in a Cloudflare production build. */
  d1Binding?: string
  /**
   * Load the libSQL driver of the default journal. Defaults to true. A Cloudflare production build without
   * `databaseUrl` sets false, because its journal is D1 or memory: see `defaultJournalNeedsLibsql()`.
   */
  libsql?: boolean
  /** The ViteHub project root of the default journal. Without it, the plugin installs no default journal. */
  projectRoot?: string
}

export interface AgentInvocationsPluginOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The deployment host. A production build for a host without a persistent filesystem warns about the local file. */
  host?: string
  /** The D1 binding of the default Database Definition on Cloudflare. A production build stores the default journal there. */
  resolveD1Binding?: (root: string, serverDirs: string[] | undefined) => string | undefined
}

const hostsWithoutPersistentFiles = new Set(["deno", "netlify", "vercel"])

/**
 * Validates `agent.invocations.retention` before code generation. Only a local SQLite journal supports maxSize.
 * D1 reports the size of the whole app database, and remote libSQL does not report file size.
 */
export function assertAgentInvocationsRetention(retention: AgentRetentionPolicy | undefined, d1: boolean, databaseUrl?: string): void {
  if (retention === undefined) return
  const { maxSize } = requireOptionalOwner(ownerModules.agentVite, "agent").normalizeRetention(retention, {
    label: "agent.invocations.retention",
    defaults: { maxAgeMs: false, maxRecords: false, maxSize: false },
    size: "any",
    error: message => viteHubErrorDiagnostics.VITE_HUB_B0015({ message: `[vitehub] ${message}` }),
  })
  if (maxSize !== false && d1) {
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
        ...(options.libsql === false ? [] : [`libsql: () => import(${JSON.stringify(agentInvocationsLibsqlModule)})`]),
      ]
    : []
  const settings = [
    ...(options.database ? [`database: () => import("vite-hub/agent/invocations/database")`] : []),
    ...(options.default !== undefined && options.default !== false ? [`default: ${JSON.stringify(options.default)}`] : []),
    ...(journal.length ? [`journal: { ${journal.join(", ")} }`] : []),
  ]
  return [
    `import { installAgentInvocations } from "@vite-hub/agent/invocations/app"`,
    "",
    // Install at module evaluation, so Agent and Console plugins that load later read the journal.
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

/** The journal store for the durability report. A remote URL becomes `remote`, so no credential reaches the server bundle. */
function journalDurabilityInput(setting: AgentInvocationsDefault | undefined, d1Binding: string | undefined): AgentInvocationsDurabilityInput | undefined {
  if (setting === false) return
  if (setting === "memory" || (typeof setting === "object" && setting.store === "memory")) return { store: "memory" }
  if (setting === "database") return { store: "database" }
  if (typeof setting === "object" && setting.store === "database") return { store: "database", ...(setting.database ? { database: setting.database } : {}) }
  if (d1Binding) return { store: "d1" }
  const databaseUrl = typeof setting === "object" && "databaseUrl" in setting && typeof setting.databaseUrl === "string" ? setting.databaseUrl : undefined
  return { store: "file", ...(databaseUrl ? { url: sqliteUrlInput(databaseUrl) } : {}) }
}

/**
 * Register a generated Nitro plugin that installs the Agent Invocation journal before other plugins.
 * Without an `agent.invocations` store, it installs the default journal, with the Console on or off.
 */
export function agentInvocationsVitePlugin(options: AgentInvocationsPluginOptions): Plugin & { vitehub: DurabilityPluginMetadata } {
  let d1Binding: string | undefined
  let libsql = true
  let localFileWarning: string | undefined
  return {
    name: "vite-hub/agent-invocations",
    vitehub: {
      durability: () => {
        const input = journalDurabilityInput(options.default, d1Binding)
        return input ? [{ export: "agentInvocationsDurability", input, module: resolveDurabilityModule(import.meta.url, "@vite-hub/agent/durability"), primitive: "agent-invocations" }] : []
      },
    },
    async config(config, environment) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_AGENT_JOURNAL_D1]?: { binding?: string }, [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], nitro?: Record<string, unknown> }
      const root = config.root || process.cwd()
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(root)
      const setting = options.default
      if (isDefaultAgentJournal(setting)) {
        // Development and an explicit `databaseUrl` keep libSQL.
        const hostD1 = viteConfig[VITEHUB_AGENT_JOURNAL_D1]
        d1Binding = environment?.command === "build" && !setting?.databaseUrl
          ? hostD1 ? hostD1.binding : options.resolveD1Binding?.(root, viteConfig[VITEHUB_SERVER_DIRS])
          : undefined
        assertAgentInvocationsRetention(setting?.retention, d1Binding !== undefined, setting?.databaseUrl)
        libsql = defaultJournalNeedsLibsql({ build: environment?.command === "build", databaseUrl: setting?.databaseUrl, host: options.host })
        if (isProductionBuild(config, environment)) assertAgentInvocationsUrl(options.host, setting?.databaseUrl)
        localFileWarning = environment?.command === "build" && !setting?.databaseUrl && hostsWithoutPersistentFiles.has(options.host ?? "")
          ? `[vitehub] Agent Invocation journal: the ${options.host} host has no persistent filesystem, so the default journal file .vitehub/data/agent-invocations.sqlite does not keep records. Set agent.invocations to "database", or set agent.invocations.databaseUrl to a remote libSQL URL.`
          : undefined
      }
      else {
        d1Binding = undefined
        libsql = true
        localFileWarning = undefined
      }
      const plugin = await writeAgentInvocationsNitroPlugin({ database: options.database, d1Binding, default: options.default, libsql, projectRoot })
      const kit = createNitroServerKit(viteConfig.nitro)
      // The Console plugin reads the app-wide journal while it loads, so this plugin loads first.
      kit.addPlugin(plugin, "start")
      viteConfig.nitro = kit.config
    },
    configResolved(config) {
      if (localFileWarning) config.logger.warn(localFileWarning)
      if (d1Binding) config.logger.info(`[vitehub] Agent Invocation journal: D1 binding ${d1Binding}, table vitehub_agent_invocations. The journal creates the table on first use.`)
    },
  }
}
