import { getViteMode } from "@vitehub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vitehub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { normalize } from "pathe"
import type { Plugin, ResolvedConfig } from "vite"

import { resolveDBViteConfig } from "./config.ts"
import { serializeSchemaObject } from "./internal/schema-serializer.ts"
import { dbPackageName, generateProviderOutputs } from "./internal/vite-build.ts"

import type { DBModulePublicOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/db/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/db/databases"
export const DB_VITE_PLUGIN_NAME = "@vitehub/db/vite"

const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
}

export type DBVitePlugin = Plugin & { api: DBVitePluginAPI }

const mergeNoExternal = createNoExternalMerger(dbPackageName)

function serializeSchemaModule(config: ResolvedDBViteConfig | undefined) {
  const defaultSchemaPaths = config?.schemaPathsByDatabase.default || []
  return [
    serializeSchemaObject(defaultSchemaPaths, "schema", true),
    "export { schema };",
    "export default schema;",
    "",
  ].join("\n")
}

function serializeDatabasesModule(config: ResolvedDBViteConfig | undefined) {
  if (!config) {
    return "export default {};\n"
  }

  const schemaBlocks = config.databaseNames.map((name, index) => serializeSchemaObject(
    config.schemaPathsByDatabase[name] || [],
    `schema_${index}`,
  ))
  const entries = config.databaseNames.map((name, index) => [
    `  ${JSON.stringify(name)}: {`,
    `    config: ${JSON.stringify(config.databases[name], null, 4)},`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    ...schemaBlocks,
    "export const databases = {",
    ...entries,
    "}",
    "",
    "export default databases",
    "",
  ].join("\n")
}

export function hubDb(options?: DBModulePublicOptions): DBVitePlugin {
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedDBViteConfig | undefined
  const getConfig = () => runtimeConfig
  const refreshRuntimeConfig = () => {
    if (!resolved) {
      return
    }

    runtimeConfig = resolveDBViteConfig(resolved.db ?? options, resolved.root)
  }

  return {
    name: DB_VITE_PLUGIN_NAME,
    api: { getConfig },
    configResolved(config) {
      resolved = config
      refreshRuntimeConfig()

      if (runtimeConfig && !runtimeConfig.schemaPathsByDatabase.default?.length) {
        throw new Error("[vitehub] No Drizzle schema files found. Create `src/db/schema.ts` or set `db.drizzle.schemaPaths`.")
      }
    },
    configEnvironment(name, config) {
      if (!isServerEnvironment(name, config)) {
        return
      }

      return {
        resolve: { noExternal: mergeNoExternal(config.resolve?.noExternal) },
      }
    },
    handleHotUpdate(context) {
      if (!runtimeConfig) {
        return
      }

      const changedFile = normalize(context.file)
      const dbDir = normalize(`${runtimeConfig.rootDir}/src/db/`)
      const isSchemaUpdate = Object.values(runtimeConfig.schemaPathsByDatabase)
        .some(paths => paths.some(path => normalize(path) === changedFile))
        || changedFile.startsWith(dbDir)
      if (!isSchemaUpdate) {
        return
      }

      refreshRuntimeConfig()

      const schemaModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_SCHEMA_ID)
      const databasesModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_DATABASES_ID)
      if (schemaModule) {
        context.server.moduleGraph.invalidateModule(schemaModule)
      }
      if (databasesModule) {
        context.server.moduleGraph.invalidateModule(databasesModule)
      }
    },
    resolveId(id) {
      if (id === DB_VIRTUAL_SCHEMA_ID) {
        return RESOLVED_DB_VIRTUAL_SCHEMA_ID
      }
      if (id === DB_VIRTUAL_DATABASES_ID) {
        return RESOLVED_DB_VIRTUAL_DATABASES_ID
      }
    },
    load(id) {
      if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) {
        return serializeSchemaModule(getConfig())
      }
      if (id === RESOLVED_DB_VIRTUAL_DATABASES_ID) {
        return serializeDatabasesModule(getConfig())
      }
    },
    async closeBundle() {
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }

      await generateProviderOutputs({
        clientOutDir: resolved.build.outDir,
        rootDir: resolved.root,
        runtimeConfig,
      })
    },
  }
}

declare module "vite" {
  interface UserConfig {
    db?: DBModulePublicOptions
  }
}
