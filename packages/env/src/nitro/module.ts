import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { resolveRuntimeEntry as resolveEntry } from "@vitehub/internal/nitro"

import { formatDiagnostics } from "../core/diagnostics.ts"
import { envSource, envVariable } from "../core/declarations.ts"
import { createRuntimeRegistry, resolveEnvSource, validateEnvConfigShape } from "../core/resolve.ts"

import type { EnvDiagnosticEntry, EnvIntegrationOptions, EnvNitroConfigOptions, EnvNitroUserConfig, EnvRegistryEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue, EnvVariableDeclaration } from "../types.ts"
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

function createRegistryContents(registry: EnvRuntimeRegistry): string {
  return [
    `export default ${JSON.stringify(registry, null, 2)}`,
    "",
  ].join("\n")
}

function createPluginContents(file: string, registryFile: string): string {
  return [
    `import registry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    `import { applyEnvRegistryToRuntimeConfig, setEnvRegistry } from ${JSON.stringify(createImportPath(file, resolveRuntimeEntry("../runtime/server", "@vitehub/env/runtime/server")))}`,
    "",
    "export default function vitehubEnvPlugin(nitroApp) {",
    "  setEnvRegistry(registry)",
    "  nitroApp?.hooks?.hook?.(\"request\", (event) => {",
    "    applyEnvRegistryToRuntimeConfig(useRuntimeConfig(), event)",
    "  })",
    "}",
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
  const fields = createTypeFields(registry, 4)
  return [
    "declare module \"#vitehub/env/server\" {",
    "  export interface SafeRuntimeConfig {",
    ...fields,
    "  }",
    "  export function useSafeRuntimeConfig(event?: unknown): SafeRuntimeConfig",
    "}",
    "",
    "declare module \"nitro/types\" {",
    "  export interface NitroRuntimeConfig {",
    ...fields,
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function createTypeFields(registry: EnvRuntimeRegistry, indent: number): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(registry).flatMap(([key, entry]) => {
    if (isRegistryEntry(entry)) {
      return [`${prefix}${JSON.stringify(key)}: ${resolveTypeName(entry)}`]
    }
    return [
      `${prefix}${JSON.stringify(key)}: {`,
      ...createTypeFields(entry, indent + 2),
      `${prefix}}`,
    ]
  })
}

function resolveTypeName(entry: EnvRegistryEntry): string {
  if (entry.type) {
    return entry.type
  }
  return entry.required || typeof entry.default !== "undefined" ? "string" : "string | undefined"
}

export function envNitro(options: EnvIntegrationOptions = {}): NitroModule {
  return {
    name: "@vitehub/env",
    async setup(nitro) {
      const config = (nitro.options as typeof nitro.options & EnvNitroUserConfig).env
      validateEnvConfigShape(config, "nitro")
      const registry = createRuntimeRegistry(config, { prefix: options.prefix })
      configureCloudflareRequiredSecrets(nitro, config, options.prefix)

      const diagnostics = describeRuntimeEntries(config, "env", options.prefix)
      const diagnosticsText = formatDiagnostics(diagnostics, options.diagnostics)
      if (diagnosticsText) {
        nitro.logger.info(diagnosticsText)
      }

      const registryFile = registryPath(nitro)
      const pluginFile = pluginPath(nitro)
      await writeFileIfChanged(registryFile, createRegistryContents(registry))
      await writeFileIfChanged(pluginFile, createPluginContents(pluginFile, registryFile))

      nitro.options.alias ||= {}
      nitro.options.alias["@vitehub/env"] = resolveRuntimeEntry("../index", "@vitehub/env")
      nitro.options.alias["#vitehub/env/server"] = resolveRuntimeEntry("../runtime/server", "@vitehub/env/runtime/server")

      nitro.options.plugins ||= []
      if (!nitro.options.plugins.includes(pluginFile)) {
        nitro.options.plugins.push(pluginFile)
      }

      installNitroTypes(nitro, registry)
    },
  }
}

function configureCloudflareRequiredSecrets(nitro: Nitro, declarations: EnvNitroConfigOptions | undefined, prefix?: string): void {
  const required = collectRequiredSecretNames(declarations, "env", prefix)

  if (required.length === 0 || !usesCloudflare(nitro)) {
    return
  }

  const options = nitro.options as typeof nitro.options & {
    cloudflare?: {
      wrangler?: {
        secrets?: {
          required?: string[]
        }
      }
    }
  }
  options.cloudflare ||= {}
  options.cloudflare.wrangler ||= {}
  options.cloudflare.wrangler.secrets ||= {}
  options.cloudflare.wrangler.secrets.required = [
    ...new Set([
      ...(options.cloudflare.wrangler.secrets.required || []),
      ...required,
    ]),
  ]
}

function collectRequiredSecretNames(declarations: EnvNitroConfigOptions | undefined, path: string, prefix?: string): string[] {
  return Object.entries(declarations || {}).flatMap(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (isEnvVariableDeclaration(value)) {
      const source = resolveEnvSource(value, valuePath, prefix)
      return value.secret && value.required && source.kind === "env" ? [source.name] : []
    }
    return collectRequiredSecretNames(value as EnvNitroConfigOptions, valuePath, prefix)
  })
}

function usesCloudflare(nitro: Nitro): boolean {
  const options = nitro.options as typeof nitro.options & { cloudflare?: unknown, preset?: unknown }
  return typeof options.cloudflare !== "undefined"
    || (typeof options.preset === "string" && options.preset.includes("cloudflare"))
}

function describeRuntimeEntries(
  declarations: EnvNitroConfigOptions | undefined,
  path = "env",
  prefix?: string,
): EnvDiagnosticEntry[] {
  return Object.entries(declarations || {}).flatMap(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (!isEnvVariableDeclaration(value)) {
      return describeRuntimeEntries(value as EnvNitroConfigOptions, valuePath, prefix)
    }
    const declaration = value
    const source = resolveEnvSource(declaration, valuePath, prefix)
    const hasRuntimeValue = source.kind === "env" && typeof process.env[source.name] !== "undefined"
    const hasDefault = typeof declaration.default !== "undefined"
    return {
      exposed: declaration.secret ? "server only, masked" : "server only",
      key: valuePath,
      masked: declaration.secret,
      mode: "runtime",
      source: hasDefault && !hasRuntimeValue ? "default" : source.label,
      status: hasRuntimeValue ? "valid" : hasDefault ? "defaulted" : "missing",
      timing: "Nitro runtime",
      type: declaration.type,
    }
  })
}

function isRegistryEntry(value: EnvRuntimeRegistryValue): value is EnvRegistryEntry {
  return "source" in value
    && typeof value.source === "object"
    && value.source !== null
    && "kind" in value.source
}

function isEnvVariableDeclaration(value: unknown): value is EnvVariableDeclaration {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && "kind" in value
    && value.kind === "env-variable"
}

const nitroModule: NitroModule = envNitro()

export default nitroModule

declare module "nitro/types" {
  interface NitroConfig {
    env?: EnvNitroConfigOptions
  }

  interface NitroOptions {
    env?: EnvNitroConfigOptions
  }
}
