import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { summarizeDefinitions } from "@vite-hub/internal/inspect"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { discoverTaskDefinitions } from "./discovery.ts"
import { renderTaskRegistryPlugin } from "./registry.ts"

import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { ViteHubInspectionPluginMetadata } from "@vite-hub/internal/inspect"
import type { Plugin } from "vite"

const generatedNitroRegistryPlugin = ".vitehub/nitro/task/registry.mjs"

interface TaskViteConfig {
  nitro?: unknown
  root?: string
  [VITEHUB_NITRO_CONFIG_CONTEXT]?: boolean
  [VITEHUB_SERVER_DIRS]?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Object(value) === value && !Array.isArray(value)
}

/**
 * Enables Nitro tasks for the discovered `server/tasks` files. The app keeps control: `nitro.experimental.tasks: false`
 * turns tasks off, and a task that `nitro.tasks` already declares keeps its handler and description.
 */
function addNitroTasks(value: unknown, definitions: ReturnType<typeof discoverTaskDefinitions>): Record<string, unknown> | undefined {
  const nitro = isRecord(value) ? { ...value } : {}
  const experimental = isRecord(nitro.experimental) ? nitro.experimental : {}
  const declaredTasks = isRecord(nitro.tasks) && Object.keys(nitro.tasks).length > 0
  if (experimental.tasks === false || (!definitions.length && !declaredTasks && experimental.tasks !== true)) return
  nitro.experimental = { ...experimental, tasks: true }
  const tasks = isRecord(nitro.tasks) ? { ...nitro.tasks } : {}
  for (const definition of definitions) {
    const existing = tasks[definition.name]
    tasks[definition.name] = isRecord(existing) ? { ...existing, handler: existing.handler ?? definition.handler } : { handler: definition.handler }
  }
  nitro.tasks = tasks
  return nitro
}

async function addNitroTaskRegistry(value: unknown, projectRoot: string): Promise<Record<string, unknown>> {
  const plugin = resolve(projectRoot, generatedNitroRegistryPlugin)
  const contents = renderTaskRegistryPlugin()
  await mkdir(dirname(plugin), { recursive: true })
  if (!existsSync(plugin) || await readFile(plugin, "utf8") !== contents) await writeFile(plugin, contents, "utf8")
  const kit = createNitroServerKit(value)
  kit.addPlugin(plugin)
  return kit.config
}

/**
 * Connects Nitro tasks in `server/tasks/` to ViteHub: it registers them with Nitro, lists them in
 * `vitehub inspect definitions`, and contributes the `task.*` operations that `vitehub task` and the Console run.
 */
export function viteHubTaskPlugin(): Plugin & { vitehub: ViteHubInspectionPluginMetadata & { operations: () => readonly OperationContributionEntry[] } } {
  let projectRoot = process.cwd()
  let serverDirs: string[] | undefined
  let active = false

  return {
    name: "vite-hub/task",
    async config(config) {
      // SAFETY: Vite passes the mutable user config object, which ViteHub hosts augment through shared symbols.
      const viteConfig = config as TaskViteConfig
      // Nuxt runs its own Nitro, which scans `server/tasks` itself.
      if (viteConfig[VITEHUB_NITRO_CONFIG_CONTEXT]) return
      const viteRoot = resolve(viteConfig.root || process.cwd())
      projectRoot = resolveViteHubProjectRoot(viteRoot)
      serverDirs = viteConfig[VITEHUB_SERVER_DIRS]
      const taskConfig = addNitroTasks(viteConfig.nitro, discoverTaskDefinitions(projectRoot, serverDirs))
      active = taskConfig !== undefined
      viteConfig.nitro = taskConfig ? await addNitroTaskRegistry(taskConfig, projectRoot) : viteConfig.nitro
    },
    vitehub: {
      // The app imports the operations through `vite-hub`. Without tasks there is nothing to list or run.
      operations: () => active
        ? [{ export: "taskOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).taskOperations, module: "vite-hub/_internal/task/operations" }]
        : [],
      inspect: () => ({
        definitions: [{
          kind: "task",
          label: "Tasks",
          list: () => summarizeDefinitions(projectRoot, discoverTaskDefinitions(projectRoot, serverDirs), "server-tasks"),
        }],
      }),
    },
  }
}
