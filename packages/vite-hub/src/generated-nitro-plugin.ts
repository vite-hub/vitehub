import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { createNitroServerKit } from "@vite-hub/internal/nitro-kit"
import { resolveViteHubProjectRoot, VITEHUB_PROJECT_ROOT } from "@vite-hub/internal/build/vite"

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
        const handlers = [kit.config.errorHandler ?? []].flat()
        if (!handlers.includes(handler)) kit.config.errorHandler = [...handlers, handler]
      }
      options.configure?.(kit.config, env)
      viteConfig.nitro = kit.config
    },
  }
}

/**
 * Write a Nitro error handler under the project's `.vitehub/nitro` folder and put it first in Nitro's `errorHandler` list.
 * Nitro calls the handlers in order and uses the first response, so this one runs before the handlers of the app and of Nuxt.
 */
export function generatedNitroErrorHandler(name: string, file: string, render: () => string): Plugin {
  return {
    name,
    async config(config) {
      // SAFETY: ViteHub and Nitro extend Vite's user config with these documented top-level keys.
      const viteConfig = config as ViteHubUserConfig
      const handler = resolve(projectRootOf(viteConfig), ".vitehub/nitro", file)
      await writeIfChanged(handler, render())
      const kit = createNitroServerKit(viteConfig.nitro)
      kit.config.errorHandler = [handler, ...[kit.config.errorHandler ?? []].flat().filter(entry => entry !== handler)]
      viteConfig.nitro = kit.config
    },
  }
}
