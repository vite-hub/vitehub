import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { formatDiagnostics } from "../core/diagnostics.ts"
import { createRuntimeRegistry, resolveRuntimeEntries, validateRuntimeConfigShape } from "../core/resolve.ts"

import type {
  RuntimeConfigIntegrationOptions,
  RuntimeConfigRegistry,
  ViteHubRuntimeConfigUserConfig,
} from "../types.ts"
import type { Nitro, NitroModule } from "nitro/types"

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function runtimeDir(nitro: Nitro): string {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/runtime-config")
}

function registryPath(nitro: Nitro): string {
  return resolve(runtimeDir(nitro), "registry.mjs")
}

function pluginPath(nitro: Nitro): string {
  return resolve(runtimeDir(nitro), "plugin.mjs")
}

function publicHandlerPath(nitro: Nitro): string {
  return resolve(runtimeDir(nitro), "public.get.mjs")
}

function createSerializableRegistry(config: RuntimeConfigRegistry): unknown {
  return JSON.parse(JSON.stringify(config, (_key, value) => _key === "schema" ? undefined : value))
}

function createRegistryContents(registry: RuntimeConfigRegistry): string {
  return [
    `export default ${JSON.stringify(createSerializableRegistry(registry), null, 2)}`,
    "",
  ].join("\n")
}

function createPluginContents(file: string, registryFile: string): string {
  return [
    `import registry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { setRuntimeConfigRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/server", "@vitehub/runtime-config/runtime/server")))}`,
    "",
    "export default function vitehubRuntimeConfigPlugin() {",
    "  setRuntimeConfigRegistry(registry)",
    "}",
    "",
  ].join("\n")
}

function createPublicHandlerContents(file: string): string {
  return [
    `import { getPublicRuntimeConfigData } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/server", "@vitehub/runtime-config/runtime/server")))}`,
    "",
    "export default event => getPublicRuntimeConfigData(event)",
    "",
  ].join("\n")
}

function installNitroTypes(nitro: Nitro, registry: RuntimeConfigRegistry): void {
  nitro.hooks?.hook?.("types:extend", async (types: { tsConfig?: { include?: string[] } }) => {
    const dtsPath = resolve(nitro.options.buildDir, "types", "vitehub-runtime-config.d.ts")
    await writeFileIfChanged(dtsPath, createNitroTypes(registry))
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(dtsPath)
    }
  })
}

function createNitroTypes(registry: RuntimeConfigRegistry): string {
  const serverFields = Object.keys(registry.server || {}).map(key => `      ${JSON.stringify(key)}: unknown`)
  const publicFields = Object.keys(registry.public || {}).map(key => `      ${JSON.stringify(key)}: unknown`)
  const bindingFields = Object.entries(registry.cloudflare?.bindings || {}).map(([key, declaration]) => `      ${JSON.stringify(key)}: ${declaration.type || "unknown"}`)
  return [
    "declare module \"#vitehub/runtime-config/server\" {",
    "  export function getRuntimeConfig(event?: unknown): {",
    "    public: {",
    ...publicFields,
    "    }",
    "    server: {",
    ...serverFields,
    "    }",
    "  }",
    "}",
    "",
    "declare module \"#vitehub/runtime-config/cloudflare\" {",
    "  export function getCloudflareRuntime(event: unknown): {",
    "    bindings: {",
    ...bindingFields,
    "    }",
    "    secrets: Record<string, unknown>",
    "    vars: Record<string, unknown>",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

export function runtimeConfigNitro(options: RuntimeConfigIntegrationOptions = {}): NitroModule {
  return {
    name: "@vitehub/runtime-config",
    async setup(nitro) {
      const config = ((nitro.options as typeof nitro.options & { vitehub?: ViteHubRuntimeConfigUserConfig }).vitehub)?.runtimeConfig
      validateRuntimeConfigShape(config, "nitro")
      const registry = createRuntimeRegistry(config)

      const diagnostics = [
        ...resolveRuntimeEntries(config?.runtime?.server, process.env, "runtime.server").diagnostics,
        ...resolveRuntimeEntries(config?.runtime?.public, process.env, "runtime.public").diagnostics,
      ]
      const diagnosticsText = formatDiagnostics(diagnostics, options.diagnostics)
      if (diagnosticsText) {
        nitro.logger.info(diagnosticsText)
      }

      const registryFile = registryPath(nitro)
      const pluginFile = pluginPath(nitro)
      const publicHandlerFile = publicHandlerPath(nitro)
      await writeFileIfChanged(registryFile, createRegistryContents(registry))
      await writeFileIfChanged(pluginFile, createPluginContents(pluginFile, registryFile))
      await writeFileIfChanged(publicHandlerFile, createPublicHandlerContents(publicHandlerFile))

      nitro.options.alias ||= {}
      nitro.options.alias["@vitehub/runtime-config"] = resolveRuntimeEntry("../index", "@vitehub/runtime-config")
      nitro.options.alias["#vitehub/runtime-config/server"] = resolveRuntimeEntry("../runtime/server", "@vitehub/runtime-config/runtime/server")
      nitro.options.alias["#vitehub/runtime-config/cloudflare"] = resolveRuntimeEntry("../runtime/cloudflare", "@vitehub/runtime-config/runtime/cloudflare")

      nitro.options.plugins ||= []
      if (!nitro.options.plugins.includes(pluginFile)) {
        nitro.options.plugins.push(pluginFile)
      }

      const optionsWithHandlers = nitro.options as typeof nitro.options & { handlers?: Array<{ handler: string, route: string }> }
      optionsWithHandlers.handlers ||= []
      if (!optionsWithHandlers.handlers.some(handler => handler.route === "/_vitehub/runtime-config")) {
        optionsWithHandlers.handlers.push({
          handler: publicHandlerFile,
          route: "/_vitehub/runtime-config",
        })
      }

      installNitroTypes(nitro, registry)
    },
  }
}

const nitroModule: NitroModule = runtimeConfigNitro()

export default nitroModule

declare module "nitro/types" {
  interface NitroConfig {
    vitehub?: ViteHubRuntimeConfigUserConfig
  }

  interface NitroOptions {
    vitehub?: ViteHubRuntimeConfigUserConfig
  }
}
