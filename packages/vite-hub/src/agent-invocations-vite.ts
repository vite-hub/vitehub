import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { isDefaultAgentJournal } from "./agent-invocations-setting.ts"
import { viteHubErrorDiagnostics } from "./error-diagnostics.ts"
import { requireOptionalOwner } from "./internal/optional-owners.ts"
import { ownerModules } from "./internal/owner-modules.ts"

import type { Plugin } from "vite"
import type { AgentRetentionPolicy } from "@vite-hub/agent/server"
import type { AgentInvocationsDefault } from "./_internal/agent/invocations.ts"

const generatedAgentInvocationsPlugin = ".vitehub/nitro/agent/invocations.mjs"

export interface AgentInvocationsRenderOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The D1 binding of the default journal in a Cloudflare production build. */
  d1Binding?: string
  /** The ViteHub project root of the default journal. Without it, the plugin installs no default journal. */
  projectRoot?: string
}

export interface AgentInvocationsPluginOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
  /** The deployment preset. A production build for a host without a persistent filesystem warns about the local file. */
  preset?: string
  /** The D1 binding of the default Database Definition on Cloudflare. A production build stores the default journal there. */
  resolveD1Binding?: (root: string, serverDirs: string[] | undefined) => string | undefined
}

const presetsWithoutPersistentFiles = new Set(["deno", "netlify", "vercel"])

/**
 * Validates `agent.invocations.retention` before code generation. The libSQL journal accepts every limit.
 * The D1 journal rejects maxSize, because D1 reports the size of the whole app database.
 */
export function assertAgentInvocationsRetention(retention: AgentRetentionPolicy | undefined, d1: boolean): void {
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
}

/** Render the Nitro plugin that installs the Database store loader and the app-wide journal before Agents run. */
export function renderAgentInvocationsNitroPlugin(options: AgentInvocationsRenderOptions): string {
  const journal = options.projectRoot !== undefined && isDefaultAgentJournal(options.default)
    ? [
        `projectRoot: ${JSON.stringify(options.projectRoot)}`,
        ...(options.d1Binding ? [`d1: { binding: ${JSON.stringify(options.d1Binding)}, env: async () => (await import("cloudflare:workers")).env }`] : []),
      ]
    : []
  const settings = [
    ...(options.database ? [`database: () => import("vite-hub/agent/invocations/database")`] : []),
    ...(options.default !== undefined && options.default !== false ? [`default: ${JSON.stringify(options.default)}`] : []),
    ...(journal.length ? [`journal: { ${journal.join(", ")} }`] : []),
  ]
  return [
    `import { installAgentInvocations } from "vite-hub/_internal/agent/invocations"`,
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

/**
 * Register a generated Nitro plugin that installs the Agent Invocation journal before other plugins.
 * Without an `agent.invocations` store, it installs the default journal, with the Console on or off.
 */
export function agentInvocationsVitePlugin(options: AgentInvocationsPluginOptions): Plugin {
  let d1Binding: string | undefined
  let localFileWarning: string | undefined
  return {
    name: "vite-hub/agent-invocations",
    async config(config, environment) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, [VITEHUB_SERVER_DIRS]?: string[], nitro?: Record<string, unknown> }
      const root = config.root || process.cwd()
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(root)
      const setting = options.default
      if (isDefaultAgentJournal(setting)) {
        // Development and an explicit `databaseUrl` keep libSQL.
        d1Binding = environment?.command === "build" && !setting?.databaseUrl
          ? options.resolveD1Binding?.(root, viteConfig[VITEHUB_SERVER_DIRS])
          : undefined
        assertAgentInvocationsRetention(setting?.retention, d1Binding !== undefined)
        localFileWarning = environment?.command === "build" && !setting?.databaseUrl && presetsWithoutPersistentFiles.has(options.preset ?? "")
          ? `[vitehub] Agent Invocation journal: the ${options.preset} preset has no persistent filesystem, so the default journal file .vitehub/data/agent-invocations.sqlite does not keep records. Set agent.invocations to "database", or set agent.invocations.databaseUrl to a remote libSQL URL.`
          : undefined
      }
      else {
        d1Binding = undefined
        localFileWarning = undefined
      }
      const plugin = await writeAgentInvocationsNitroPlugin({ database: options.database, d1Binding, default: options.default, projectRoot })
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
