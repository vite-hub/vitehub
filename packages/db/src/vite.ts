import { getViteMode } from "@vitehub/internal/build/mode"
import { shouldSkipViteProviderBuild } from "@vitehub/internal/build/deployment-output"
import { createNoExternalMerger, isServerEnvironment } from "@vitehub/internal/build/vite"
import { normalize } from "pathe"

import { resolveDBViteConfig } from "./config.ts"
import { writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { dbPackageName, generateProviderOutputs } from "./internal/vite-build.ts"

import type { Plugin, ResolvedConfig } from "vite"
import type { DBModulePublicOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/db/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/db/databases"
export const DB_VITE_PLUGIN_NAME = "@vitehub/db/vite"

const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
  refresh: () => Promise<ResolvedDBViteConfig | undefined>
}

interface DBCliContributingPlugin {
  vitehub?: {
    cli?: unknown
  }
}

export type DBVitePlugin = Plugin & DBCliContributingPlugin & { api: DBVitePluginAPI }

const mergeNoExternal = createNoExternalMerger(dbPackageName)

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

function renderDatabaseConfigExpression(name: string, config: ResolvedDBViteConfig, definitionVariable: string) {
  const base = config.databases[name]!
  return [
    "{",
    `      ...${JSON.stringify(base, null, 6)},`,
    `      cloudflare: ${definitionVariable}.cloudflare ? { ...${definitionVariable}.cloudflare, binding: ${definitionVariable}.cloudflare.binding ?? ${JSON.stringify(base.cloudflare?.binding ?? (name === "default" ? "DB" : `DB_${name.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").replace(/_+/g, "_").toUpperCase() || "DATABASE"}`))}, migrationsDir: ${JSON.stringify(base.migrationsDir)} } : undefined,`,
    `      connection: ${definitionVariable}.connection ? { ...${JSON.stringify(base.connection)}, ...${definitionVariable}.connection, authToken: ${definitionVariable}.connection.authToken ?? ${JSON.stringify(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${JSON.stringify(base.connection?.url)} } : ${JSON.stringify(base.connection)},`,
    `      drizzle: ${definitionVariable}.drizzle ?? {},`,
    "    }",
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
  let resolved: ResolvedConfig | undefined
  let runtimeConfig: ResolvedDBViteConfig | undefined

  async function refreshRuntimeConfig() {
    if (!resolved) return
    runtimeConfig = resolveDBViteConfig(resolved.db ?? options, resolved.root)
    if (runtimeConfig) {
      await writeGeneratedDatabaseArtifacts(runtimeConfig)
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
        const { createDbCliContributor } = await import(/* @vite-ignore */ "./cli.js")
        return createDbCliContributor(options === false ? false : options?.cli)
      },
    },
    async configResolved(config) {
      resolved = config
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
    resolveId(id) {
      if (id === DB_VIRTUAL_SCHEMA_ID) return RESOLVED_DB_VIRTUAL_SCHEMA_ID
      if (id === DB_VIRTUAL_DATABASES_ID) return RESOLVED_DB_VIRTUAL_DATABASES_ID
    },
    load(id) {
      if (id === RESOLVED_DB_VIRTUAL_SCHEMA_ID) return renderSchemaModule(runtimeConfig)
      if (id === RESOLVED_DB_VIRTUAL_DATABASES_ID) return renderDatabasesModule(runtimeConfig)
    },
    async closeBundle() {
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }

      await writeGeneratedDatabaseArtifacts(runtimeConfig)
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
