import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { env } from "./core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"

import type { EnvIntegrationOptions, EnvRuntimeRegistry, EnvRuntimeRegistryValue, EnvViteConfigOptions, EnvViteUserConfig } from "./types.ts"
import type { Plugin, UserConfig } from "vite"

export const ENV_VITE_PLUGIN_NAME = "@vite-hub/env/vite"
export const ENV_PUBLIC_ID = "#vitehub/env/public"
export const ENV_SERVER_ID = "#vitehub/env/server"

const RESOLVED_PUBLIC_ID = `\0${ENV_PUBLIC_ID}`
const RESOLVED_SERVER_ID = `\0${ENV_SERVER_ID}`

export { env }

export interface EnvVitePluginAPI {
  getPublicEnv: () => Record<string, unknown>
  getServerEnvRegistry: () => EnvRuntimeRegistry
}

export type EnvVitePlugin = Plugin & { api: EnvVitePluginAPI }

export function hubEnv(options: EnvIntegrationOptions = {}): EnvVitePlugin {
  let buildPublicConfig: Record<string, unknown> = {}
  let serverRegistry: EnvRuntimeRegistry = {}
  let diagnosticsText: string | undefined
  const getPublicEnv = () => buildPublicConfig
  const getServerEnvRegistry = () => serverRegistry

  return {
    name: ENV_VITE_PLUGIN_NAME,
    api: { getPublicEnv, getServerEnvRegistry },
    async config(config, env) {
      const envConfig = (config as UserConfig & EnvViteUserConfig).env
      validateEnvConfigShape(envConfig, "vite")
      if (!envConfig) {
        return
      }

      const root = resolve(config.root || process.cwd())
      const loadedEnv = loadEnv(env.mode, root, "")
      const context = createSourceContext({
        env: { ...loadedEnv, ...process.env },
        mode: "build",
        rootDir: root,
      })

      const publicResult = await resolveEnvEntries(envConfig.public, {
        context,
        exposure: "build public",
        prefix: options.prefix,
        section: "env.public",
        timing: "Vite config/dev/build",
      })
      const defineResult = await resolveEnvEntries(envConfig.define, {
        context,
        exposure: "compile-time replacement",
        prefix: options.prefix,
        section: "env.define",
        timing: "Vite transform/build",
      })

      buildPublicConfig = Object.fromEntries(publicResult.entries.map(entry => [entry.key, entry.value]))
      serverRegistry = createRuntimeRegistry(envConfig.server, { prefix: options.prefix })
      diagnosticsText = formatDiagnostics([...publicResult.diagnostics, ...defineResult.diagnostics], options.diagnostics)

      return {
        define: {
          ...Object.fromEntries(defineResult.entries.map(entry => [entry.key, JSON.stringify(entry.value)])),
          ...config.define,
        },
      }
    },
    async configResolved(config) {
      if (diagnosticsText) {
        config.logger.info(diagnosticsText)
      }
      await writeFileIfChanged(
        resolve(config.root, ".vitehub/env/vite.d.ts"),
        createViteTypes(buildPublicConfig, serverRegistry),
      )
    },
    load(id) {
      if (id === RESOLVED_PUBLIC_ID) {
        return [
          `const publicEnv = ${JSON.stringify(buildPublicConfig, null, 2)};`,
          "export function usePublicEnv() { return publicEnv; }",
          "export { publicEnv };",
        ].join("\n")
      }
      if (id === RESOLVED_SERVER_ID) {
        return createServerModule(serverRegistry)
      }
    },
    resolveId(id) {
      if (id === ENV_PUBLIC_ID) {
        return RESOLVED_PUBLIC_ID
      }
      if (id === ENV_SERVER_ID) {
        return RESOLVED_SERVER_ID
      }
    },
  }
}

function createViteTypes(config: Record<string, unknown>, serverRegistry: EnvRuntimeRegistry): string {
  const fields = Object.entries(config).map(([key, value]) => `    ${JSON.stringify(key)}: ${typeof value}`)
  return [
    "declare module \"#vitehub/env/public\" {",
    "  export interface PublicEnv {",
    ...fields,
    "  }",
    "  export const publicEnv: PublicEnv",
    "  export function usePublicEnv(): PublicEnv",
    "}",
    "declare module \"#vitehub/env/server\" {",
    "  import type { SecretEnv } from \"@vite-hub/env/secret\"",
    "  export interface ServerEnv {",
    ...createServerTypeFields(serverRegistry, 4),
    "  }",
    "  export function useServerEnv(event?: unknown): ServerEnv",
    "}",
    "export {}",
    "",
  ].join("\n")
}

function createServerTypeFields(registry: EnvRuntimeRegistry, indent: number): string[] {
  const prefix = " ".repeat(indent)
  return Object.entries(registry).map(([key, value]) => {
    const optional = isOptionalServerValue(value) ? "?" : ""
    return `${prefix}${JSON.stringify(key)}${optional}: ${serverTypeFor(value, indent)}`
  })
}

function serverTypeFor(value: EnvRuntimeRegistryValue, indent: number): string {
  if (isLiteralEntry(value)) return literalType(value.value)
  if (isEnvEntry(value)) return value.secret ? "SecretEnv<string>" : "string"

  const fields = createServerTypeFields(value, indent + 2)
  if (!fields.length) return "Record<string, never>"
  const prefix = " ".repeat(indent)
  return `{\n${fields.join("\n")}\n${prefix}}`
}

function isOptionalServerValue(value: EnvRuntimeRegistryValue): boolean {
  return isEnvEntry(value) && !value.required && typeof value.default === "undefined"
}

function literalType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    const items = value.map(item => literalType(item)).join(", ")
    return `readonly [${items}]`
  }
  switch (typeof value) {
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(value)
    default:
      return "unknown"
  }
}

function isLiteralEntry(value: EnvRuntimeRegistryValue): value is Extract<EnvRuntimeRegistryValue, { kind: "literal" }> {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "literal")
}

function isEnvEntry(value: EnvRuntimeRegistryValue): value is Extract<EnvRuntimeRegistryValue, { source: unknown }> {
  return Boolean(value && typeof value === "object" && "source" in value)
}

function createServerModule(registry: EnvRuntimeRegistry): string {
  return [
    "import { SecretEnv } from \"@vite-hub/env/secret\"",
    "",
    `const registry = ${JSON.stringify(registry, null, 2)};`,
    "",
    "function isRecord(value) {",
    "  return value !== null && typeof value === 'object'",
    "}",
    "",
    "function readCarrierEnv(event) {",
    "  if (!isRecord(event)) return undefined",
    "  if (isRecord(event.env)) return event.env",
    "  if (isRecord(event.context?.cloudflare?.env)) return event.context.cloudflare.env",
    "  if (isRecord(event.context?._platform?.cloudflare?.env)) return event.context._platform.cloudflare.env",
    "  if (isRecord(event.req?.runtime?.cloudflare?.env)) return event.req.runtime.cloudflare.env",
    "  return event",
    "}",
    "",
    "function readRuntimeEnv(name, event) {",
    "  const carrier = readCarrierEnv(event)",
    "  const globalEnv = isRecord(globalThis.__env__) ? globalThis.__env__ : undefined",
    "  const processEnv = typeof process !== 'undefined' && isRecord(process.env) ? process.env : undefined",
    "  return carrier?.[name] ?? globalEnv?.[name] ?? processEnv?.[name]",
    "}",
    "",
    "function readSource(source, event) {",
    "  for (const name of source.names || [source.name]) {",
    "    const value = readRuntimeEnv(name, event)",
    "    if (typeof value !== 'undefined') return { name, value }",
    "  }",
    "  return { name: source.name, value: undefined }",
    "}",
    "",
    "function resolveEntry(entry, event, path) {",
    "  if (entry?.kind === 'literal') return entry.value",
    "  if (isRecord(entry) && isRecord(entry.source)) {",
    "    const resolved = readSource(entry.source, event)",
    "    let value = typeof resolved.value === 'undefined' ? entry.default : resolved.value",
    "    if (typeof value === 'undefined') {",
    "      if (entry.required) throw new Error(`[vitehub] Missing Server Env ${path} from ${entry.source.label}.`)",
    "      return undefined",
    "    }",
    "    if (typeof value !== 'string') throw new Error(`[vitehub] Server Env ${path} from env:${resolved.name} must be a string.`)",
    "    return entry.secret ? new SecretEnv(value) : value",
    "  }",
    "  const output = {}",
    "  for (const [key, value] of Object.entries(entry || {})) output[key] = resolveEntry(value, event, path ? `${path}.${key}` : key)",
    "  return output",
    "}",
    "",
    "export function useServerEnv(event) {",
    "  return resolveEntry(registry, event, '')",
    "}",
    "",
  ].join("\n")
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
