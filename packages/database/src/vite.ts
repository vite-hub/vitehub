import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { contributeProviderDeploymentOutput, finalizeProviderDeploymentOutputs, resetProviderDeploymentOutputs, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment, resolveNitroVercelFunctionName, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalize } from "pathe"

import { createDbCliContributor } from "./cli.ts"
import { resolveDBViteConfig } from "./config.ts"
import { removeGeneratedDatabaseTypes, writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { renderDatabaseConfigExpression } from "./internal/runtime-config-expression.ts"
import { dbPackageName, generateProviderOutputs, prepareProviderOutputs } from "./internal/vite-build.ts"
import { createDatabaseProvisionStep } from "./provision.ts"

import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"
import type { DBModulePublicOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/database/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/database/databases"
const DB_VIRTUAL_DEFINITION_DEFAULTS_ID = "#vitehub/database/definition-defaults"
export const DB_VITE_PLUGIN_NAME = "@vite-hub/database/vite"

const DB_INTERNAL_VIRTUAL_SCHEMA_ID = "virtual:vitehub/database/schema"
const DB_INTERNAL_VIRTUAL_DATABASES_ID = "virtual:vitehub/database/databases"
const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`
const RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID = `\0${DB_VIRTUAL_DEFINITION_DEFAULTS_ID}`
const DB_DRIZZLE_ENTRY_PATTERN = /(?:^|\/)(?:@vite-hub\/database|database)\/dist\/drizzle\.js$/

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
  refresh: () => Promise<ResolvedDBViteConfig | undefined>
}

interface DBCliContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor | undefined>
  }
}

export type DBVitePlugin = Plugin & DBCliContributingPlugin & { api: DBVitePluginAPI }

const mergeNoExternal = createNoExternalMerger(dbPackageName)

function resolveDatabaseVirtualId(id: string) {
  if (id === DB_VIRTUAL_SCHEMA_ID || id === DB_INTERNAL_VIRTUAL_SCHEMA_ID) return RESOLVED_DB_VIRTUAL_SCHEMA_ID
  if (id === DB_VIRTUAL_DATABASES_ID || id === DB_INTERNAL_VIRTUAL_DATABASES_ID) return RESOLVED_DB_VIRTUAL_DATABASES_ID
  if (id === DB_VIRTUAL_DEFINITION_DEFAULTS_ID) return RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID
}

function rewriteDrizzleVirtualImports(code: string) {
  return code
    .replaceAll(DB_VIRTUAL_SCHEMA_ID, DB_INTERNAL_VIRTUAL_SCHEMA_ID)
    .replaceAll(DB_VIRTUAL_DATABASES_ID, DB_INTERNAL_VIRTUAL_DATABASES_ID)
}

function renderSchemaModule(config: ResolvedDBViteConfig | undefined) {
  if (!config?.databaseNames.length) {
    return "const schema = {}\nexport { schema }\nexport default schema\n"
  }
  const defaultName = config.databaseNames.includes("default") ? "default" : config.databaseNames[0]!
  return [
    `export * from ${JSON.stringify(config.generatedSchemaFilesByDatabase[defaultName])}`,
    `export { default, schema } from ${JSON.stringify(config.generatedSchemaFilesByDatabase[defaultName])}`,
    "",
  ].join("\n")
}

function renderDatabasesModule(config: ResolvedDBViteConfig | undefined) {
  if (!config?.databaseNames.length) {
    return "export const databases = {}\nexport default databases\n"
  }

  const imports = config.definitions.map((definition, index) => [
    `import definition_${index} from ${JSON.stringify(definition.handler)}`,
    `import schema_${index} from ${JSON.stringify(config.generatedSchemaFilesByDatabase[definition.name])}`,
  ].join("\n"))
  const entries = config.definitions.map((definition, index) => [
    `  ${JSON.stringify(definition.name)}: {`,
    `    config: ${renderDatabaseConfigExpression(definition.name, config, `definition_${index}`)},`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    ...imports,
    "",
    "export const databases = {",
    ...entries,
    "}",
    "export default databases",
    "",
  ].join("\n")
}

export function hubDb(options?: DBModulePublicOptions): DBVitePlugin {
  let providerArtifacts: Awaited<ReturnType<typeof prepareProviderOutputs>> | undefined
  let providerOutput: ProviderOutputCatalog | undefined
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedDBViteConfig | undefined
  let serverDirs: string[] | undefined

  function resolvedOptions() {
    return resolved?.database ?? options
  }

  function databaseRoot() {
    const database = resolvedOptions()
    return resolve(resolved?.root ?? process.cwd(), database && "projectRoot" in database ? database.projectRoot ?? "." : ".")
  }

  function databaseServerDirs() {
    const database = resolvedOptions()
    return database && "projectRoot" in database && database.projectRoot !== undefined
      ? [resolve(databaseRoot(), "server")]
      : serverDirs
  }

  async function refreshRuntimeConfig() {
    if (!resolved) return
    runtimeConfig = resolveDBViteConfig(resolvedOptions(), databaseRoot(), { serverDirs: databaseServerDirs() })
    if (runtimeConfig) {
      await writeGeneratedDatabaseArtifacts(runtimeConfig)
    } else {
      await removeGeneratedDatabaseTypes(databaseRoot())
    }
    return runtimeConfig
  }

  return {
    name: DB_VITE_PLUGIN_NAME,
    api: {
      getConfig: () => runtimeConfig,
      refresh: refreshRuntimeConfig,
    },
    vitehub: {
      cli: async () => {
        const db = resolvedOptions()
        if (db === false) return
        const contributor = createDbCliContributor(db?.cli, refreshRuntimeConfig)
        const provision = [createDatabaseProvisionStep(databaseRoot, db)]
        return contributor ? { ...contributor, provision } : { namespaces: [], provision }
      },
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      await refreshRuntimeConfig()
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    buildStart() {
      resetProviderOutputRuntime(providerOutput)
    },
    async handleHotUpdate(context) {
      if (!runtimeConfig) return

      const changedFile = normalize(context.file)
      const isDatabaseUpdate = runtimeConfig.definitions.some(definition => normalize(definition.handler) === changedFile)
      if (!isDatabaseUpdate) return

      await refreshRuntimeConfig()

      const schemaModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_SCHEMA_ID)
      const databasesModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_DATABASES_ID)
      if (schemaModule) context.server.moduleGraph.invalidateModule(schemaModule)
      if (databasesModule) context.server.moduleGraph.invalidateModule(databasesModule)
    },
    async buildEnd(error) {
      if (error) {
        await resetProviderDeploymentOutputs(providerOutput)
        return
      }
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }

      await writeGeneratedDatabaseArtifacts(runtimeConfig)
      providerArtifacts = await prepareProviderOutputs({
        appRootDir: resolved.root,
        providerOutput,
        rootDir: databaseRoot(),
        runtimeConfig,
      })
      contributeProviderDeploymentOutput(providerOutput, {
        owner: "database",
        rootDir: resolved.root,
        write: async ({ write }) => {
          await writeGeneratedDatabaseArtifacts(runtimeConfig!)
          await generateProviderOutputs({
            artifacts: providerArtifacts,
            clientOutDir: resolved!.build.outDir,
            providerOutput,
            rootDir: resolved!.root,
            runtimeConfig: runtimeConfig!,
            serverFunctionName: resolveNitroVercelFunctionName(resolved!, "database"),
          }, write)
        },
      })
    },
    resolveId(id) {
      return resolveDatabaseVirtualId(id)
    },
    transform(code, id) {
      if (DB_DRIZZLE_ENTRY_PATTERN.test(normalize(id))) return rewriteDrizzleVirtualImports(code)
    },
    load(id) {
      if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) return renderSchemaModule(runtimeConfig)
      if (id === RESOLVED_DB_VIRTUAL_DATABASES_ID) return renderDatabasesModule(runtimeConfig)
      if (id === RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID) {
        const options = resolvedOptions()
        return `export default ${JSON.stringify({
          ...(options && options.driver === "d1" ? { cloudflare: { binding: options.binding } } : {}),
          ...(options && options.connection ? { connection: options.connection } : {}),
        })}\n`
      }
    },
    closeBundle: {
      order: "post",
      async handler() {
        if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) return
        await finalizeProviderDeploymentOutputs(providerOutput)
      },
    },
  }
}

declare module "vite" {
  interface UserConfig {
    database?: DBModulePublicOptions
  }
}
