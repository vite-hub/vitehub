import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import type { Plugin } from "vite"

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

interface GeneratedNitroPluginOptions {
  position?: "start" | "end"
  /** Declarations to write next to the plugin. `.vitehub/types.d.ts` references them. */
  types?: string
}

/** Write a Nitro plugin under the project's `.vitehub/nitro` folder and register it with Nitro. */
export function generatedNitroPlugin(name: string, file: string, render: () => string, options: GeneratedNitroPluginOptions = {}): Plugin {
  return {
    name,
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as typeof config & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }
      const projectRoot = typeof viteConfig[VITEHUB_PROJECT_ROOT] === "string"
        ? resolve(viteConfig[VITEHUB_PROJECT_ROOT])
        : resolveViteHubProjectRoot(config.root || process.cwd())
      const plugin = resolve(projectRoot, ".vitehub/nitro", file)
      await writeIfChanged(plugin, render())
      if (options.types) await writeIfChanged(plugin.replace(/\.mjs$/, "-types.d.ts"), options.types)
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin, options.position)
      viteConfig.nitro = kit.config
    },
  }
}
