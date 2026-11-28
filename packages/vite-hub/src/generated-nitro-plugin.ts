import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

import type { Nitro } from "nitro/types"
import type { ConfigEnv, Plugin, UserConfig } from "vite"

async function writeIfChanged(file: string, contents: string): Promise<void> {
  if (await readFile(file, "utf8").catch(() => undefined) === contents) return
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents, "utf8")
}

interface GeneratedNitroPluginOptions {
  position?: "start" | "end"
  /** Declarations to write next to the plugin. `.vitehub/types.d.ts` references them. */
  types?: string
  configure?: (nitro: Record<string, unknown>, env: ConfigEnv) => void
  errorHandler?: () => string
  when?: (projectRoot: string) => boolean
}

type ViteHubUserConfig = UserConfig & { [VITEHUB_PROJECT_ROOT]?: string, nitro?: Record<string, unknown> }

function projectRootOf(config: ViteHubUserConfig): string {
  return typeof config[VITEHUB_PROJECT_ROOT] === "string"
    ? resolve(config[VITEHUB_PROJECT_ROOT])
    : resolveViteHubProjectRoot(config.root || process.cwd())
}

function registerErrorHandler(config: Record<string, unknown>, file: string, position: "first" | "before-default"): void {
  const handler = sep === "\\" ? file.replaceAll("\\", "/") : file
  const modules = Array.isArray(config.modules) ? config.modules : []
  config.modules = [...modules, (nitro: Nitro) => {
    nitro.hooks.hook("build:before", () => {
      const handlers = [nitro.options.errorHandler].flat().filter(entry => entry !== handler)
      handlers.splice(position === "first" ? 0 : -1, 0, handler)
      nitro.options.errorHandler = handlers
    })
  }]
}

/** Write a Nitro plugin under the project's `.vitehub/nitro` folder and register it with Nitro. */
export function generatedNitroPlugin(name: string, file: string, render: () => string, options: GeneratedNitroPluginOptions = {}): Plugin {
  return {
    name,
    async config(config, env) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as ViteHubUserConfig
      const projectRoot = projectRootOf(viteConfig)
      if (options.when && !options.when(projectRoot)) return
      const plugin = resolve(projectRoot, ".vitehub/nitro", file)
      await writeIfChanged(plugin, render())
      if (options.types) await writeIfChanged(plugin.replace(/\.mjs$/, "-types.d.ts"), options.types)
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.addPlugin(plugin, options.position)
      if (options.errorHandler) {
        const handler = plugin.replace(/\.mjs$/, "-handler.mjs")
        await writeIfChanged(handler, options.errorHandler())
        registerErrorHandler(kit.config, handler, "before-default")
      }
      options.configure?.(kit.config, env)
      viteConfig.nitro = kit.config
    },
  }
}

export function generatedNitroErrorHandler(name: string, file: string, render: () => string): Plugin {
  return {
    name,
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as ViteHubUserConfig
      const handler = resolve(projectRootOf(viteConfig), ".vitehub/nitro", file)
      await writeIfChanged(handler, render())
      const kit = createNitroServerKit(viteConfig.nitro)
      registerErrorHandler(kit.config, handler, "first")
      viteConfig.nitro = kit.config
    },
  }
}
