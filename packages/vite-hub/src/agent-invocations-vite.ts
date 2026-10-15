import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import type { Plugin } from "vite"
import type { AgentInvocationsDefault } from "./_internal/agent/invocations.ts"

const generatedAgentInvocationsPlugin = ".vitehub/nitro/agent/invocations.mjs"

export interface AgentInvocationsPluginOptions {
  /** Load the Database store, so `invocations: "database"` works in Agent Definitions. */
  database: boolean
  default?: AgentInvocationsDefault
}

/** Render the Nitro plugin that installs the Database store loader and the app-wide journal before Agents run. */
export function renderAgentInvocationsNitroPlugin(options: AgentInvocationsPluginOptions): string {
  const settings = [
    ...(options.database ? [`database: () => import("vite-hub/agent/invocations/database")`] : []),
    ...(options.default !== undefined && options.default !== false ? [`default: ${JSON.stringify(options.default)}`] : []),
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

/** Register a generated Nitro plugin that installs Agent Invocation journal selection before other plugins. */
export function agentInvocationsVitePlugin(options: AgentInvocationsPluginOptions): Plugin {
  return {
    name: "vite-hub/agent-invocations",
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }
      // doctor-disable-next-line typescript/strict/no-runtime-typeof -- Narrow the optional extension value before resolving its path.
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const plugin = resolve(projectRoot, generatedAgentInvocationsPlugin)
      await writeIfChanged(plugin, renderAgentInvocationsNitroPlugin(options))
      const kit = createNitroServerKit(viteConfig.nitro)
      // The Console plugin reads the app-wide journal while it loads, so this plugin loads first.
      kit.addPlugin(plugin, "start")
      viteConfig.nitro = kit.config
    },
  }
}
