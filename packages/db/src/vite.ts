import { getViteMode, VITEHUB_MODES } from "@vitehub/internal/build/mode"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"

import { dbPackageName, generateProviderOutputs } from "./internal/vite-build.ts"
import {
  resolveDBViteConfig,
} from "./config.ts"

import type { DBModuleOptions, ResolvedDBViteConfig } from "./types.ts"
import type { Plugin, ResolvedConfig } from "vite"

export const DB_VIRTUAL_CONFIG_ID = "virtual:@vitehub/db/config"
export const DB_VIRTUAL_SCHEMA_ID = "virtual:@vitehub/db/schema"
export const DB_VITE_PLUGIN_NAME = "@vitehub/db/vite"

const RESOLVED_DB_VIRTUAL_CONFIG_ID = `\0${DB_VIRTUAL_CONFIG_ID}`
const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
}

export type DBVitePlugin = Plugin & { api: DBVitePluginAPI }

const mergeNoExternal = createNoExternalMerger(dbPackageName)

function serializeConfig(config: ResolvedDBViteConfig | undefined) {
  return `export default ${JSON.stringify(config)};\n`
}

function serializeSchemaModule(config: ResolvedDBViteConfig | undefined) {
  if (!config?.schemaPaths.length) {
    return [
      "throw new Error(",
      JSON.stringify("[vitehub] No Drizzle schema files found. Create `src/db/schema.ts` or set `db.drizzle.schemaPaths`."),
      ");",
      "",
    ].join("\n")
  }

  const imports = config.schemaPaths.map((file, index) => `import * as schema${index} from ${JSON.stringify(file)};`)
  const exports = config.schemaPaths.map(file => `export * from ${JSON.stringify(file)};`)
  const schemaRefs = config.schemaPaths.map((_, index) => `schema${index}`)

  return [
    ...imports,
    ...exports,
    `const schema = Object.assign({}, ${schemaRefs.join(", ")});`,
    "export { schema };",
    "export default schema;",
    "",
  ].join("\n")
}

export function hubDb(options?: DBModuleOptions): DBVitePlugin {
  let resolved: ResolvedConfig | undefined
  let runtimeConfig = resolveDBViteConfig(options)
  const getConfig = () => runtimeConfig

  return {
    name: DB_VITE_PLUGIN_NAME,
    api: { getConfig },
    configResolved(config) {
      resolved = config
      runtimeConfig = resolveDBViteConfig(config.db ?? options, config.root)
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

      const isSchemaUpdate = runtimeConfig.schemaPaths.includes(context.file)
        || context.file.includes("/src/db/")
      if (!isSchemaUpdate) {
        return
      }

      const configModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_CONFIG_ID)
      const schemaModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_SCHEMA_ID)
      if (configModule) {
        context.server.moduleGraph.invalidateModule(configModule)
      }
      if (schemaModule) {
        context.server.moduleGraph.invalidateModule(schemaModule)
      }
    },
    resolveId(id) {
      if (id === DB_VIRTUAL_CONFIG_ID) {
        return RESOLVED_DB_VIRTUAL_CONFIG_ID
      }
      if (id === DB_VIRTUAL_SCHEMA_ID) {
        return RESOLVED_DB_VIRTUAL_SCHEMA_ID
      }
    },
    load(id) {
      if (id === RESOLVED_DB_VIRTUAL_CONFIG_ID) {
        return serializeConfig(getConfig())
      }
      if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) {
        return serializeSchemaModule(getConfig())
      }
    },
    async closeBundle() {
      if (!resolved || !runtimeConfig || resolved.command === "serve" || getViteMode() === VITEHUB_MODES.e2e) {
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
    db?: DBModuleOptions
  }
}
