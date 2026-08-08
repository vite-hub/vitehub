import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"

import { createRuntimeRegistryContents } from "@vite-hub/internal/definition-catalog"
import { VITEHUB_SERVER_DIRS, resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"

import { discoverRealtimeDefinitions } from "./discovery.ts"

import type { Plugin, UserConfig } from "vite"
import type { RealtimeModuleOptions } from "./types.ts"

interface NitroConfig extends Record<string, unknown> {
  features?: Record<string, unknown>
  handlers?: Array<Record<string, unknown>>
}

function moduleSpecifier(from: string, to: string): string {
  const value = relative(dirname(from), to).replaceAll("\\", "/")
  return value.startsWith(".") ? value : `./${value}`
}

export function hubRealtime(options: RealtimeModuleOptions = {}): Plugin {
  return {
    name: "@vite-hub/realtime/vite",
    enforce: "pre",
    async config(config) {
      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), options)
      const serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS]
      const definitions = discoverRealtimeDefinitions(root, serverDirs)
      if (definitions.length === 0) return

      config.resolve = {
        ...config.resolve,
        dedupe: [...new Set([...(config.resolve?.dedupe || []), "yjs"])],
      }

      const directory = resolve(root, ".vitehub/nitro/realtime")
      const registryFile = resolve(directory, "registry.mjs")
      const handlerFile = resolve(directory, "handler.ts")
      await mkdir(directory, { recursive: true })
      await Promise.all([
        writeFile(registryFile, createRuntimeRegistryContents(registryFile, definitions)),
        writeFile(handlerFile, [
          `import registry from ${JSON.stringify(moduleSpecifier(handlerFile, registryFile))}`,
          `import { createRealtimeHandler } from ${JSON.stringify("vite-hub/realtime/server")}`,
          "",
          "export default createRealtimeHandler(registry)",
          "",
        ].join("\n")),
      ])

      const nitro = { ...((config as { nitro?: NitroConfig }).nitro || {}) }
      nitro.features = { ...nitro.features, websocket: true }
      nitro.handlers = [
        ...(nitro.handlers || []),
        { handler: handlerFile, route: "/api/_vitehub/realtime/**" },
      ]
      ;(config as UserConfig & { nitro?: NitroConfig }).nitro = nitro
    },
  }
}
