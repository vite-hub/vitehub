import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"

import { createRuntimeEnvRegistry, env } from "@vite-hub/env/vite"
import { createNoExternalAddition, hasNitroConfigContext, isServerEnvironment, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"

import { createConnectionsCliContributor } from "./cli.ts"
import { discoverConnectionDefinitions } from "./discovery.ts"
import { connectionsErrorDiagnostics } from "./error-diagnostics.ts"

import type { EnvRuntimeRegistry, EnvVariableDeclaration } from "@vite-hub/env"
import type { ViteHubCliPluginMetadata } from "@vite-hub/internal/cli"
import type { DiscoveredConnectionDefinition } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const CONNECTIONS_RUNTIME_ID = "#vitehub/connections/runtime"
export const CONNECTIONS_VITE_PLUGIN_NAME = "@vite-hub/connections/vite"

const resolvedConnectionsRuntimeId = `\0${CONNECTIONS_RUNTIME_ID}`
const addNoExternal = createNoExternalAddition("@vite-hub/connections")

export interface ConnectionsVitePluginOptions {
  /** Database that stores grants and activity. Default: `"default"`. */
  database?: string
  /**
   * 32-byte base64url key that seals grants.
   * Default: `env({ secret: true, optional: true, source: env.source("VITEHUB_CONNECTIONS_KEY") })`.
   */
  encryptionKey?: EnvVariableDeclaration
  projectRoot?: string
}

interface InternalConnectionsVitePluginOptions {
  databaseImport?: string
  runtimeEnvImport?: string
}

export interface ConnectionsVitePluginAPI {
  getDefinitions: () => DiscoveredConnectionDefinition[]
  refresh: () => DiscoveredConnectionDefinition[]
}

export type ConnectionsVitePlugin = Plugin & { api: ConnectionsVitePluginAPI, vitehub: ViteHubCliPluginMetadata }

function isRecord(value: unknown): value is Record<string, unknown> {
  // doctor-disable-next-line typescript/strict/no-runtime-typeof -- config values are untyped records from Vite and Nitro.
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function keyRegistry(declaration: EnvVariableDeclaration = env({ optional: true, secret: true, source: env.source("VITEHUB_CONNECTIONS_KEY") })): EnvRuntimeRegistry {
  if (!declaration.secret) {
    throw connectionsErrorDiagnostics.CONNECTIONS_B0001({ message: "[vitehub] connections.encryptionKey must be a secret env() declaration." })
  }
  if (declaration.source?.kind === "provider") {
    throw connectionsErrorDiagnostics.CONNECTIONS_B0001({ message: "[vitehub] connections.encryptionKey cannot use env.provider() because the key is resolved synchronously." })
  }
  if (declaration.default !== undefined) {
    throw connectionsErrorDiagnostics.CONNECTIONS_B0002({ message: "[vitehub] connections.encryptionKey cannot have a default because defaults are included in build output." })
  }
  return createRuntimeEnvRegistry({ key: declaration }, { path: "connections" })
}

function defaultRuntimeEnvImport(): string {
  return resolve(dirname(createRequire(import.meta.url).resolve("@vite-hub/env/package.json")), "dist/server.js")
}

function renderRuntime(
  definitions: DiscoveredConnectionDefinition[],
  options: { database: string, databaseImport: string, keys: EnvRuntimeRegistry, runtimeEnvImport: string },
): string {
  return [
    `import { databases as vitehubConnectionsDatabases } from ${JSON.stringify(options.databaseImport)}`,
    `import { resolveServerEnv as vitehubConnectionsEnv } from ${JSON.stringify(options.runtimeEnvImport)}`,
    "",
    `const keys = ${JSON.stringify(options.keys)}`,
    "const registry = Object.create(null)",
    ...definitions.map(definition => `registry[${JSON.stringify(definition.name)}] = () => import(${JSON.stringify(definition.handler)})`),
    "",
    "export default {",
    `  database: () => vitehubConnectionsDatabases[${JSON.stringify(options.database)}]?.db,`,
    "  encryptionKey: (event) => vitehubConnectionsEnv(keys, event).key?.unseal(),",
    "  registry,",
    "}",
    "",
  ].join("\n")
}

function renderRegistryTypes(definitions: DiscoveredConnectionDefinition[]): string {
  return [
    "declare global {",
    "  interface ViteHubConnectionDefinitionModules {",
    ...definitions.map(definition =>
      `    ${JSON.stringify(definition.name)}: typeof import(${JSON.stringify(definition.handler)})`
    ),
    "  }",
    "}",
    "",
    "export {}",
    "",
  ].join("\n")
}

function configureNitroConnections(config: Record<string, unknown>, runtimeFile: string): Record<string, unknown> {
  const nitro = isRecord(config.nitro) ? config.nitro : {}
  const alias = isRecord(nitro.alias) ? nitro.alias : {}
  const externals = isRecord(nitro.externals) ? nitro.externals : {}
  const existingInline = Array.isArray(externals.inline) ? externals.inline : []
  const inline = externals.inline === true
    ? true
    : [...new Set([...existingInline, "vite-hub", "@vite-hub/connections"])]
  return {
    ...nitro,
    alias: { ...alias, [CONNECTIONS_RUNTIME_ID]: runtimeFile },
    externals: { ...externals, inline },
  }
}

function isConnectionDefinitionFile(file: string, projectRoot: string, serverDirs: string[] | undefined): boolean {
  const normalized = resolve(file).replace(/\\/g, "/")
  return (serverDirs ?? [resolve(projectRoot, "server")]).some((directory) => {
    const connectionDirectory = `${resolve(directory, "connections").replace(/\\/g, "/")}/`
    return normalized.startsWith(connectionDirectory)
      && /\.(?:c|m)?[jt]sx?$/i.test(normalized.slice(connectionDirectory.length))
  })
}

/**
 * Discovers `server/connections/*.ts` and generates the Connections runtime module.
 * Grants and activity are stored in the app database.
 */
export function hubConnections(options: ConnectionsVitePluginOptions & InternalConnectionsVitePluginOptions = {}): ConnectionsVitePlugin {
  const keys = keyRegistry(options.encryptionKey)
  const renderOptions = {
    database: options.database ?? "default",
    databaseImport: options.databaseImport ?? "@vite-hub/database/drizzle",
    keys,
    runtimeEnvImport: options.runtimeEnvImport ?? defaultRuntimeEnvImport(),
  }
  let resolved: ResolvedConfig | undefined
  let definitions: DiscoveredConnectionDefinition[] = []
  let serverDirs: string[] | undefined
  let projectRoot = process.cwd()
  let nitroRuntimeFile: string | undefined

  function refresh(): DiscoveredConnectionDefinition[] {
    projectRoot = resolveViteHubProjectRoot(resolve(resolved?.root ?? process.cwd()), { projectRoot: options.projectRoot })
    definitions = discoverConnectionDefinitions({ rootDir: projectRoot, serverDirs })
    return definitions
  }

  async function refreshGeneratedFiles(): Promise<void> {
    await Promise.all([
      writeFileIfChanged(resolve(projectRoot, ".vitehub", "types", "connections.d.ts"), renderRegistryTypes(definitions)),
      ...(nitroRuntimeFile ? [writeFileIfChanged(nitroRuntimeFile, renderRuntime(definitions, renderOptions))] : []),
    ])
  }

  return {
    name: CONNECTIONS_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getDefinitions: () => definitions,
      refresh,
    },
    vitehub: {
      cli: createConnectionsCliContributor,
    },
    async config(config) {
      // SAFETY: The vite-hub distribution sets VITEHUB_SERVER_DIRS to a string array before this plugin runs.
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
      const nextConfig: Record<string, unknown> = {
        ssr: { noExternal: addNoExternal(config.ssr?.noExternal) },
      }
      if (hasNitroConfigContext(config)) {
        const root = resolveViteHubProjectRoot(resolve(config.root || process.cwd()), { projectRoot: options.projectRoot })
        nitroRuntimeFile = resolve(root, ".vitehub", "nitro", "connections", "runtime.ts")
        await writeFileIfChanged(nitroRuntimeFile, renderRuntime(discoverConnectionDefinitions({ rootDir: root, serverDirs }), renderOptions))
        // SAFETY: hasNitroConfigContext checked that config is an object with Nitro settings.
        ;(config as { nitro?: Record<string, unknown> }).nitro = configureNitroConnections(config as Record<string, unknown>, nitroRuntimeFile)
      }
      return nextConfig
    },
    async configResolved(config) {
      resolved = config
      refresh()
      await refreshGeneratedFiles()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) return
      return {
        resolve: { noExternal: addNoExternal(config.resolve?.noExternal) },
      }
    },
    async handleHotUpdate(context) {
      if (!isConnectionDefinitionFile(context.file, projectRoot, serverDirs)) return
      resolved = context.server.config
      refresh()
      await refreshGeneratedFiles()
      const module = context.server.moduleGraph.getModuleById(resolvedConnectionsRuntimeId)
      if (module) context.server.moduleGraph.invalidateModule(module)
    },
    resolveId(id) {
      if (id === CONNECTIONS_RUNTIME_ID) return resolvedConnectionsRuntimeId
    },
    load(id) {
      if (id === resolvedConnectionsRuntimeId) return renderRuntime(definitions, renderOptions)
    },
  }
}
