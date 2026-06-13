import { rm } from "node:fs/promises"
import { resolve } from "node:path"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { loadEnv } from "vite"

import { formatDiagnostics } from "./core/diagnostics.ts"
import { env } from "./core/declarations.ts"
import { createRuntimeRegistry, createSourceContext, resolveEnvEntries, validateEnvConfigShape } from "./core/resolve.ts"

import type {
  EnvIntegrationOptions,
  EnvRuntimeRegistry,
  EnvRuntimeRegistryValue,
  EnvViteConfigOptions,
  EnvViteUserConfig,
} from "./types.ts"
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

type NitroConfig = {
  alias?: Record<string, string>
} & Record<string, unknown>

type ViteConfigWithEnvNitro = UserConfig & {
  nitro?: NitroConfig
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

      const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()))
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
      serverRegistry = createRuntimeRegistry(envConfig.server, {
        prefix: options.prefix,
      })
      diagnosticsText = formatDiagnostics([...publicResult.diagnostics, ...defineResult.diagnostics], options.diagnostics)

      return {
        define: {
          ...Object.fromEntries(defineResult.entries.map(entry => [entry.key, JSON.stringify(entry.value)])),
          ...config.define,
        },
        nitro: mergeNitroEnvConfig((config as ViteConfigWithEnvNitro).nitro, createGeneratedEnvImportAliases(root)),
      }
    },
    async configResolved(config) {
      if (diagnosticsText) {
        config.logger.info(diagnosticsText)
      }
      await refreshEnvGeneratedFiles(resolveViteHubProjectRoot(config.root), buildPublicConfig, serverRegistry)
    },
    load(id) {
      if (id === RESOLVED_PUBLIC_ID) {
        return createPublicEnvModule(buildPublicConfig)
      }
      if (id === RESOLVED_SERVER_ID) {
        return createServerEnvModule(serverRegistry)
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

function envAmbientTypesPath(root: string) {
  return resolve(root, ".vitehub", "types", "env.d.ts")
}

function envPublicModulePath(root: string) {
  return resolve(root, ".vitehub", "env", "public.mjs")
}

function envServerModulePath(root: string) {
  return resolve(root, ".vitehub", "env", "server.mjs")
}

function createGeneratedEnvImportAliases(root: string): Record<string, string> {
  return {
    [ENV_PUBLIC_ID]: envPublicModulePath(root),
    [ENV_SERVER_ID]: envServerModulePath(root),
  }
}

function mergeNitroEnvConfig(value: unknown, aliases: Record<string, string>): NitroConfig {
  const nitro: NitroConfig = isRecord(value) ? { ...value } : {}
  return {
    ...nitro,
    alias: {
      ...(isRecord(nitro.alias) ? nitro.alias : {}),
      ...aliases,
    },
  }
}

function legacyEnvAmbientTypesPaths(root: string) {
  return [
    resolve(root, ".vitehub", "env", "vite.d.ts"),
  ]
}

async function refreshEnvGeneratedFiles(root: string, publicConfig: Record<string, unknown>, serverRegistry: EnvRuntimeRegistry): Promise<void> {
  await Promise.all([
    writeFileIfChanged(envAmbientTypesPath(root), createViteTypes(publicConfig, serverRegistry)),
    writeFileIfChanged(envPublicModulePath(root), createPublicEnvModule(publicConfig)),
    writeFileIfChanged(envServerModulePath(root), createServerEnvModule(serverRegistry)),
    ...legacyEnvAmbientTypesPaths(root).map(path => rm(path, { force: true })),
  ])
}

function createPublicEnvModule(publicConfig: Record<string, unknown>): string {
  return [
    `const publicEnv = ${JSON.stringify(publicConfig, null, 2)};`,
    "export function usePublicEnv() { return publicEnv; }",
    "export { publicEnv };",
    "",
  ].join("\n")
}

function createServerEnvModule(serverRegistry: EnvRuntimeRegistry): string {
  return [
    "import { resolveServerEnv, runWithServerEnv as runWithGeneratedServerEnv } from '@vite-hub/env/server';",
    `const registry = ${JSON.stringify(serverRegistry, null, 2)};`,
    "export function useServerEnv(event) { return resolveServerEnv(registry, event); }",
    "export function runWithServerEnv(event, callback) { return runWithGeneratedServerEnv(event, callback); }",
    "",
  ].join("\n")
}

function createViteTypes(publicConfig: Record<string, unknown>, serverRegistry: EnvRuntimeRegistry): string {
  const publicFields = Object.entries(publicConfig).map(([key, value]) => `    ${JSON.stringify(key)}: ${typeof value}`)
  return [
    "declare module \"#vitehub/env/public\" {",
    "  export interface PublicEnv {",
    ...publicFields,
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
    "  export function runWithServerEnv<T>(event: unknown, callback: () => T): T",
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

  const fields = createServerTypeFields(value as EnvRuntimeRegistry, indent + 2)
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
  if (!isRecord(value)) return false
  const record = value as Record<string, unknown>
  return record.kind === "literal"
}

function isEnvEntry(value: EnvRuntimeRegistryValue): value is Extract<EnvRuntimeRegistryValue, { source: unknown }> {
  if (!isRecord(value)) return false
  const record = value as Record<string, unknown>
  return isRecord(record.source)
    && typeof record.required === "boolean"
    && typeof record.secret === "boolean"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

declare module "vite" {
  interface UserConfig {
    env?: EnvViteConfigOptions
  }
}
