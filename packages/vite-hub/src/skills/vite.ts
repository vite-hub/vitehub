import { ownModule } from "@vite-hub/internal/build/paths"
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"

import { renderServedSkillsRegistryPlugin } from "./registry.ts"

import type { OperationContributionEntry } from "@vite-hub/internal/operations"
import type { Plugin } from "vite"

const generatedRegistryPlugin = ".vitehub/nitro/skills/registry.mjs"

/** The `server/skills.{ts,js}` file of the project, or undefined. */
export function findServedSkillsEntry(options: { projectRoot: string, serverDirs?: readonly string[] }): string | undefined {
  const directories = options.serverDirs === undefined ? [resolve(options.projectRoot, "server")] : options.serverDirs.map(directory => resolve(options.projectRoot, directory))
  return directories
    .flatMap(directory => ["skills.ts", "skills.mts", "skills.js", "skills.mjs"].map(name => join(directory, name)))
    .find(file => existsSync(file))
}

/**
 * Connects `server/skills.ts` to the Console and the CLI: a generated Nitro plugin hands its module to the
 * `served-skills.*` operations, which list the skills and turn them on and off. Inert without the file.
 */
export function viteHubServedSkillsPlugin(): Plugin & { vitehub: { operations: () => readonly OperationContributionEntry[] } } {
  let active = false
  return {
    name: "vite-hub/skills",
    async config(config) {
      const configuredRoot: unknown = Reflect.get(config, VITEHUB_PROJECT_ROOT)
      const projectRoot = typeof configuredRoot === "string" ? resolve(configuredRoot) : resolveViteHubProjectRoot(resolve(config.root ?? process.cwd()))
      const dirs: unknown = Reflect.get(config, VITEHUB_SERVER_DIRS)
      const serverDirs = Array.isArray(dirs) ? dirs.filter((dir): dir is string => typeof dir === "string") : undefined
      const entry = findServedSkillsEntry({ projectRoot, ...(serverDirs ? { serverDirs } : {}) })
      active = entry !== undefined
      if (!entry) return
      const plugin = resolve(projectRoot, generatedRegistryPlugin)
      const contents = renderServedSkillsRegistryPlugin(entry)
      await mkdir(dirname(plugin), { recursive: true })
      if (!existsSync(plugin) || await readFile(plugin, "utf8") !== contents) await writeFile(plugin, contents, "utf8")
      const kit = createNitroServerKit(Reflect.get(config, "nitro"))
      kit.addPlugin(plugin)
      Reflect.set(config, "nitro", kit.config)
    },
    vitehub: {
      operations: () => active
        ? [{ export: "servedSkillsOperations", load: async () => (await import(/* @vite-ignore */ import.meta.url.endsWith(".ts") ? "./operations.ts" : "./operations.js")).servedSkillsOperations, module: ownModule(import.meta.url, "skills/operations") }]
        : [],
    },
  }
}
