import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { formatDiagnostics } from "../core/diagnostics.ts"
import { envSource, envVariable } from "../core/declarations.ts"
import { createRuntimeRegistry, validateEnvConfigShape } from "../core/resolve.ts"

import type { EnvConfigOptions, EnvDiagnosticEntry, EnvIntegrationOptions, EnvRuntimeRegistry, EnvUserConfig, EnvVariableDeclaration } from "../types.ts"
import type { Nitro, NitroModule } from "nitro/types"

export { envSource, envVariable }

function resolveRuntimeEntry(srcRelative: string, packageSubpath: string): string {
  return resolveEntry(srcRelative, packageSubpath, import.meta.url)
}

function runtimeDir(nitro: Nitro): string {
  return resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/env")
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

function createRegistryContents(registry: EnvRuntimeRegistry): string {
  return [
    `export default ${JSON.stringify(registry, null, 2)}`,
    "",
  ].join("\n")
}

function createPluginContents(file: string, registryFile: string): string {
  return [
    `import registry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { setEnvRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/server", "@vitehub/env/runtime/server")))}`,
    "",
    "export default function vitehubEnvPlugin() {",
    "  setEnvRegistry(registry)",
    "}",
    "",
  ].join("\n")
}

function createPublicHandlerContents(file: string): string {
  return [
    `import { getPublicRuntimeConfigData } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/server", "@vitehub/env/runtime/server")))}`,
    "",
    "export default event => getPublicRuntimeConfigData(event)",
    "",
  ].join("\n")
}

function installNitroTypes(nitro: Nitro, registry: EnvRuntimeRegistry): void {
  nitro.hooks?.hook?.("types:extend", async (types: { tsConfig?: { include?: string[] } }) => {
    const dtsPath = resolve(nitro.options.buildDir, "types", "vitehub-env.d.ts")
    await writeFileIfChanged(dtsPath, createNitroTypes(registry))
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(dtsPath)
    }
  })
}

function createNitroTypes(registry: EnvRuntimeRegistry): string {
  const serverFields = Object.keys(registry.server || {}).map(key => `      ${JSON.stringify(key)}: unknown`)
  const publicFields = Object.keys(registry.public || {}).map(key => `      ${JSON.stringify(key)}: unknown`)
  return [
    "declare module \"#vitehub/env/server\" {",
    "  export function useSafeRuntimeConfig(event?: unknown): {",
    "    public: {",
    ...publicFields,
    "    }",
    "    server: {",
    ...serverFields,
    "    }",
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

export function envNitro(options: EnvIntegrationOptions = {}): NitroModule {
  return {
    name: "@vitehub/env",
    async setup(nitro) {
      const config = (nitro.options as typeof nitro.options & EnvUserConfig).env
      validateEnvConfigShape(config, "nitro")
      const registry = createRuntimeRegistry(config)

      const diagnostics = [
        ...describeRuntimeEntries(config?.server, "env.server", "server only"),
        ...describeRuntimeEntries(config?.public, "env.public", "public runtime transport"),
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
      nitro.options.alias["@vitehub/env"] = resolveRuntimeEntry("../index", "@vitehub/env")
      nitro.options.alias["#vitehub/env/server"] = resolveRuntimeEntry("../runtime/server", "@vitehub/env/runtime/server")

      nitro.options.plugins ||= []
      if (!nitro.options.plugins.includes(pluginFile)) {
        nitro.options.plugins.push(pluginFile)
      }

      const optionsWithHandlers = nitro.options as typeof nitro.options & { handlers?: Array<{ handler: string, route: string }> }
      optionsWithHandlers.handlers ||= []
      if (!optionsWithHandlers.handlers.some(handler => handler.route === "/_vitehub/env")) {
        optionsWithHandlers.handlers.push({
          handler: publicHandlerFile,
          route: "/_vitehub/env",
        })
      }

      installNitroTypes(nitro, registry)
    },
  }
}

function describeRuntimeEntries(
  declarations: Record<string, EnvVariableDeclaration> | undefined,
  section: "env.public" | "env.server",
  exposure: "public runtime transport" | "server only",
): EnvDiagnosticEntry[] {
  return Object.entries(declarations || {}).map(([key, declaration]) => {
    const hasRuntimeValue = declaration.source.kind === "env" && typeof process.env[declaration.source.name] !== "undefined"
    const hasDefault = typeof declaration.default !== "undefined"
    return {
      exposed: declaration.secret ? `${exposure}, masked` : exposure,
      key: `${section}.${key}`,
      masked: declaration.secret,
      mode: "runtime",
      source: hasDefault && !hasRuntimeValue ? "default" : declaration.source.label,
      status: hasRuntimeValue ? "valid" : hasDefault ? "defaulted" : "missing",
      timing: "Nitro runtime",
      type: declaration.type,
    }
  })
}

const nitroModule: NitroModule = envNitro()

export default nitroModule

declare module "nitro/types" {
  interface NitroConfig {
    env?: EnvConfigOptions
  }

  interface NitroOptions {
    env?: EnvConfigOptions
  }
}
