import { resolve } from "node:path"

import { createImportPath } from "@vitehub/internal/build/paths"
import { writeFileIfChanged } from "@vitehub/internal/definition-catalog"
import { assertNoVitePluginInNitro, mergeNitroImportsPreset, resolveRuntimeEntry } from "@vitehub/internal/nitro"

import { formatDiagnostics } from "../core/diagnostics.ts"
import { env } from "../core/declarations.ts"
import { createRuntimeRegistry, isEnvVariableDeclaration, resolveEnvSource, validateEnvConfigShape } from "../core/resolve.ts"

import type { EnvDiagnosticEntry, EnvIntegrationOptions, EnvNitroConfigOptions, EnvNitroUserConfig, EnvRegistryEntry, EnvRuntimeLiteralEntry, EnvRuntimeRegistry, EnvRuntimeRegistryValue } from "../types.ts"
import type { Nitro, NitroModule } from "nitro/types"

export { env }

const ENV_VITE_PLUGIN_NAME = "@vitehub/env/vite"
const ENV_NITRO_IMPORTS_PRESET = { from: "#vitehub/env/server", imports: ["useServerEnv"] }

function resolveEntry(srcRelative: string, packageSubpath: string): string {
  return resolveRuntimeEntry(srcRelative, packageSubpath, import.meta.url)
}

function createRegistryContents(registry: EnvRuntimeRegistry): string {
  return `export default ${JSON.stringify(registry, null, 2)}\n`
}

function createPluginContents(file: string, registryFile: string): string {
  return [
    `import registry from ${JSON.stringify(createImportPath(file, registryFile))}`,
    `import { useRuntimeConfig } from "nitro/runtime-config"`,
    `import { applyRuntimeEnvToRuntimeConfig, setEnvRegistry } from ${JSON.stringify(createImportPath(file, resolveEntry("../runtime/server", "@vitehub/env/runtime/server")))}`,
    "",
    "export default function vitehubEnvPlugin(nitroApp) {",
    "  setEnvRegistry(registry)",
    "  globalThis.__vitehubApplyRuntimeEnvToRuntimeConfig = (runtimeConfig, event) => applyRuntimeEnvToRuntimeConfig(runtimeConfig, event)",
    "  nitroApp?.hooks?.hook?.(\"request\", (event) => {",
    "    applyRuntimeEnvToRuntimeConfig(useRuntimeConfig(), event)",
    "  })",
    "}",
    "",
  ].join("\n")
}

async function writeNitroTypes(nitro: Nitro, registry: EnvRuntimeRegistry): Promise<string[]> {
  const dtsPath = resolve(nitro.options.buildDir, "types", "vitehub-env.d.ts")
  const integrationsDtsPath = resolve(nitro.options.buildDir, "types", "vitehub-env-integrations.d.ts")
  await writeFileIfChanged(dtsPath, createNitroServerTypes(registry))
  await writeFileIfChanged(integrationsDtsPath, createNitroIntegrationTypes(registry))
  return [dtsPath, integrationsDtsPath]
}

async function installNitroTypes(nitro: Nitro, registry: EnvRuntimeRegistry): Promise<void> {
  await writeNitroTypes(nitro, registry)
  nitro.hooks.hook("types:extend", async (types: { tsConfig?: { include?: string[] } }) => {
    const dtsPaths = await writeNitroTypes(nitro, registry)
    if (types.tsConfig) {
      types.tsConfig.include ||= []
      types.tsConfig.include.push(...dtsPaths)
    }
  })
}

function createNitroServerTypes(registry: EnvRuntimeRegistry): string {
  const fields = createTypeFields(registry, 4)
  return [
    "declare module \"#vitehub/env/server\" {",
    "  export class SecretEnv<T = string> {",
    "    constructor(value: T)",
    "    unseal(): T",
    "    toString(): string",
    "    toJSON(): string",
    "    [Symbol.toPrimitive](): string",
    "  }",
    "  export interface ServerEnv {",
    ...fields,
    "  }",
    "  export function useServerEnv(event?: unknown): ServerEnv",
    "}",
    "",
  ].join("\n")
}

function createNitroIntegrationTypes(registry: EnvRuntimeRegistry): string {
  const fields = createTypeFields(registry, 4)
  return [
    "import type { SecretEnv } from \"#vitehub/env/server\"",
    "import \"nitro/types\"",
    "",
    "declare module \"nitro/types\" {",
    "  export interface NitroRuntimeConfig {",
    ...fields,
    "  }",
    "}",
    "",
    "declare module \"@vitehub/agent/chat\" {",
    "  export interface ChatRuntimeConfig {",
    ...fields,
    "  }",
    "}",
    "",
    "declare module \"@vitehub/agent\" {",
    "  export interface AgentRuntimeConfig {",
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
    if (isLiteralEntry(entry)) {
      return [`${prefix}${JSON.stringify(key)}: ${resolveLiteralTypeName(entry.value)}`]
    }
    return [
      `${prefix}${JSON.stringify(key)}: {`,
      ...createTypeFields(entry, indent + 2),
      `${prefix}}`,
    ]
  })
}

function resolveTypeName(entry: EnvRegistryEntry): string {
  if (entry.secret) {
    const valueType = entry.type ?? "string"
    const typeName = `SecretEnv<${valueType}>`
    return entry.required || typeof entry.default !== "undefined" ? typeName : `${typeName} | undefined`
  }
  if (entry.type) {
    return entry.type
  }
  return entry.required || typeof entry.default !== "undefined" ? "string" : "string | undefined"
}

function resolveLiteralTypeName(value: unknown): string {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false"
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "number"
    case "string":
      return JSON.stringify(value)
    case "object":
      return value === null ? "null" : "unknown[]"
    default:
      return "unknown"
  }
}

export function envNitro(options: EnvIntegrationOptions = {}): NitroModule {
  return {
    name: "@vitehub/env",
    async setup(nitro) {
      await assertNoVitePluginInNitro(nitro, ENV_VITE_PLUGIN_NAME, "@vitehub/env/nitro")

      const config = (nitro.options as typeof nitro.options & EnvNitroUserConfig).env
      validateEnvConfigShape(config, "nitro")
      const registry = createRuntimeRegistry(config, { prefix: options.prefix })
      configureCloudflareRequiredSecrets(nitro, config, options.prefix)

      const diagnostics = describeRuntimeEntries(config, options.prefix)
      const diagnosticsText = formatDiagnostics(diagnostics, options.diagnostics)
      if (diagnosticsText) {
        nitro.logger.info(diagnosticsText)
      }

      const runtimeDir = resolve(nitro.options.rootDir, ".vitehub/nitro-runtime/env")
      const registryFile = resolve(runtimeDir, "registry.mjs")
      const pluginFile = resolve(runtimeDir, "plugin.mjs")
      await writeFileIfChanged(registryFile, createRegistryContents(registry))
      await writeFileIfChanged(pluginFile, createPluginContents(pluginFile, registryFile))

      nitro.options.alias ||= {}
      nitro.options.alias["@vitehub/env"] = resolveEntry("../index", "@vitehub/env")
      nitro.options.alias["#vitehub/env/server"] = resolveEntry("../runtime/server", "@vitehub/env/runtime/server")
      nitro.options.alias["#vitehub/env/registry"] = registryFile

      nitro.options.plugins ||= []
      if (!nitro.options.plugins.includes(pluginFile)) {
        nitro.options.plugins.push(pluginFile)
      }

      const importsExplicitlyDisabled = nitro.options._config?.imports === false
      if (!importsExplicitlyDisabled) {
        nitro.options.imports = mergeNitroImportsPreset(nitro.options.imports === false ? {} : nitro.options.imports, ENV_NITRO_IMPORTS_PRESET) as typeof nitro.options.imports
      }

      await installNitroTypes(nitro, registry)
    },
  }
}

function configureCloudflareRequiredSecrets(nitro: Nitro, declarations: EnvNitroConfigOptions | undefined, prefix?: string): void {
  const required = collectRequiredSecretNames(declarations, prefix)

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

function collectRequiredSecretNames(declarations: EnvNitroConfigOptions | undefined, prefix?: string, path = "env"): string[] {
  return Object.entries(declarations || {}).flatMap(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (isEnvVariableDeclaration(value)) {
      const source = resolveEnvSource(value, valuePath, prefix)
      return value.secret && value.required && source.kind === "env" ? [source.name] : []
    }
    if (!isPlainRecord(value)) {
      return []
    }
    return collectRequiredSecretNames(value as EnvNitroConfigOptions, prefix, valuePath)
  })
}

function usesCloudflare(nitro: Nitro): boolean {
  const options = nitro.options as typeof nitro.options & { cloudflare?: unknown, preset?: unknown }
  return typeof options.cloudflare !== "undefined"
    || (typeof options.preset === "string" && options.preset.includes("cloudflare"))
}

function describeRuntimeEntries(
  declarations: EnvNitroConfigOptions | undefined,
  prefix?: string,
  path = "env",
): EnvDiagnosticEntry[] {
  return Object.entries(declarations || {}).flatMap(([key, value]) => {
    const valuePath = `${path}.${key}`
    if (!isEnvVariableDeclaration(value)) {
      if (!isPlainRecord(value)) {
        return []
      }
      return describeRuntimeEntries(value as EnvNitroConfigOptions, prefix, valuePath)
    }
    const source = resolveEnvSource(value, valuePath, prefix)
    const activeSource = resolveActiveEnvSourceLabel(source)
    const hasRuntimeValue = typeof activeSource.value !== "undefined"
    const hasDefault = typeof value.default !== "undefined"
    const exposure = valuePath === "env.public" || valuePath.startsWith("env.public.")
      ? "public runtime transport"
      : "server only"
    return {
      exposed: value.secret ? `${exposure}, masked` : exposure,
      key: valuePath,
      masked: value.secret,
      mode: "runtime",
      source: hasDefault && !hasRuntimeValue ? "default" : activeSource.label,
      status: hasRuntimeValue ? "valid" : hasDefault ? "defaulted" : "missing",
      timing: "Nitro runtime",
      type: value.type,
    }
  })
}

function resolveActiveEnvSourceLabel(source: ReturnType<typeof resolveEnvSource>): { label: string, value: string | undefined } {
  if (source.kind !== "env") {
    return { label: source.label, value: undefined }
  }
  for (const name of source.names || [source.name]) {
    const value = process.env[name]
    if (typeof value !== "undefined") {
      return { label: `env:${name}`, value }
    }
  }
  return { label: source.label, value: undefined }
}

function isRegistryEntry(value: EnvRuntimeRegistryValue): value is EnvRegistryEntry {
  const source = (value as { source?: unknown }).source
  return typeof source === "object"
    && source !== null
    && (source as { kind?: unknown }).kind === "env"
    && typeof (source as { name?: unknown }).name === "string"
}

function isLiteralEntry(value: EnvRuntimeRegistryValue): value is EnvRuntimeLiteralEntry {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { kind?: unknown }).kind === "literal"
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
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
