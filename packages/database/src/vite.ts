import { randomUUID } from "node:crypto"
import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { resolve } from "node:path"

import { getViteMode } from "@vite-hub/internal/build/mode"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { contributeProviderDeploymentOutput, createDefaultCloudflareOutputRoot, createDefaultVercelOutputRoot, createProviderDeploymentOutputGenerationState, finalizeProviderDeploymentOutputs, resetProviderOutputRuntime, shouldSkipViteProviderBuild, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { removeProviderOutputArtifactDir, retainProviderOutputSources } from "@vite-hub/internal/build/provider-output-sources"
import { createNoExternalAddition, isServerEnvironment, resolveNitroVercelFunctionName, resolveViteHubProjectRoot, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"
import { normalize } from "pathe"
import { computePackageDir, resolveRuntimeModule } from "@vite-hub/internal/build/paths"

import { createDbCliContributor } from "./cli.ts"
import { cloudflareOptions, mergeCloudflareD1Bindings, resolveCloudflareD1Bindings } from "./internal/cloudflare.ts"
import { resolveDBViteConfig } from "./config.ts"
import { removeGeneratedDatabaseTypes, writeGeneratedDatabaseArtifacts } from "./internal/generated.ts"
import { renderDatabaseConfigExpression } from "./internal/runtime-config-expression.ts"
import { dbPackageName, generateProviderOutputs, prepareProviderOutputs, shouldCreateCloudflareOutput, shouldCreateVercelOutput } from "./internal/vite-build.ts"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { inspectDatabaseDefinitions } from "./inspect.ts"
import { createDatabaseProvisionStep } from "./provision.ts"

import type { ViteHubCliContributor } from "@vite-hub/internal/cli"
import type { ViteHubInspectionContributor } from "@vite-hub/internal/inspect"
import type { ProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { Plugin, ResolvedConfig } from "vite"
import type { DBModulePublicOptions, ResolvedDBViteConfig } from "./types.ts"

export const DB_VIRTUAL_SCHEMA_ID = "#vitehub/database/schema"
export const DB_VIRTUAL_DATABASES_ID = "#vitehub/database/databases"
const DB_VIRTUAL_DEFINITION_DEFAULTS_ID = "#vitehub/database/definition-defaults"
export const DB_VITE_PLUGIN_NAME = "@vite-hub/database/vite"
export { inspectDatabaseDefinitions, type DatabaseInspectionOptions } from "./inspect.ts"

const DB_INTERNAL_VIRTUAL_SCHEMA_ID = "virtual:vitehub/database/schema"
const DB_INTERNAL_VIRTUAL_DATABASES_ID = "virtual:vitehub/database/databases"
const RESOLVED_DB_VIRTUAL_SCHEMA_ID = `\0${DB_VIRTUAL_SCHEMA_ID}`
const RESOLVED_DB_VIRTUAL_DATABASES_ID = `\0${DB_VIRTUAL_DATABASES_ID}`
const RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID = `\0${DB_VIRTUAL_DEFINITION_DEFAULTS_ID}`
const NITRO_MIGRATIONS_DIR = ".vitehub/database/migrations"
const DB_DRIZZLE_ENTRY_PATTERN = /(?:^|\/)(?:@vite-hub\/database|database)\/dist\/drizzle\.js$/

export interface DBVitePluginAPI {
  getConfig: () => ResolvedDBViteConfig | undefined
  isEnabled: () => boolean
  refresh: () => Promise<ResolvedDBViteConfig | undefined>
}

interface DBCliContributingPlugin {
  vitehub?: {
    cli?: () => Promise<ViteHubCliContributor | undefined>
    inspect?: () => ViteHubInspectionContributor | undefined
  }
}

/** The Nitro surface that the database plugin reads and extends on a Cloudflare host. */
interface DatabaseNitroHost {
  hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
  options: {
    cloudflare?: { wrangler?: { d1_databases?: unknown } }
    output: { serverDir: string }
    preset?: string
  }
}

export type DBVitePlugin = Plugin & DBCliContributingPlugin & {
  api: DBVitePluginAPI
  nitro: { name: string, setup: (nitro: DatabaseNitroHost) => void }
}

const mergeNoExternal = createNoExternalAddition(dbPackageName)

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
    `import { resolveRuntimeCloudflareConfig } from ${JSON.stringify(resolveRuntimeModule(computePackageDir(import.meta.url), "runtime/hosted"))}`,
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
  let nitroOptions: DatabaseNitroHost["options"] | undefined
  let nitroMigrations: Array<{ source: string, target: string }> = []
  let providerOutput: ProviderOutputCatalog | undefined
  const providerOutputGenerations = createProviderDeploymentOutputGenerationState()
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
    runtimeConfig = resolveDBViteConfig(resolvedOptions(), databaseRoot(), {
      provisionRoot: resolved.root,
      serverDirs: databaseServerDirs(),
    })
    if (runtimeConfig) {
      await writeGeneratedDatabaseArtifacts(runtimeConfig)
    } else {
      await removeGeneratedDatabaseTypes(databaseRoot())
    }
    return runtimeConfig
  }

  // Nitro writes `wrangler.json` from its own options, so a Cloudflare Nitro build needs the D1 bindings there.
  // Wrangler resolves `migrations_dir` from that file, so migration SQL is copied beside it.
  function mergeNitroCloudflareD1Bindings() {
    if (!nitroOptions || !runtimeConfig || getHostingProvider(nitroOptions.preset) !== "cloudflare") return
    const { d1Databases } = resolveCloudflareD1Bindings(runtimeConfig, { provisionState: readProvisionStateSync(resolved?.root ?? process.cwd()) })
    if (!d1Databases.length) return
    const bindings = d1Databases.map(binding => binding.migrations_dir
      ? { ...binding, migrations_dir: `${NITRO_MIGRATIONS_DIR}/${binding.binding}` }
      : binding)
    nitroMigrations = d1Databases.flatMap(binding => binding.migrations_dir
      ? [{ source: resolve(databaseRoot(), binding.migrations_dir), target: `${NITRO_MIGRATIONS_DIR}/${binding.binding}` }]
      : [])
    const wrangler = (nitroOptions.cloudflare ??= {}).wrangler ??= {}
    wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, bindings)
  }

  async function copyNitroMigrations(serverDir: string) {
    if (!nitroMigrations.length) return
    await rm(resolve(serverDir, NITRO_MIGRATIONS_DIR), { force: true, recursive: true })
    await Promise.all(nitroMigrations.map(async ({ source, target }) => {
      const outputDir = resolve(serverDir, target)
      const entries = await readdir(source, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      await mkdir(outputDir, { recursive: true })
      await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
        .map(entry => copyFile(resolve(source, entry.name), resolve(outputDir, entry.name))))
    }))
  }

  return {
    name: DB_VITE_PLUGIN_NAME,
    enforce: "pre",
    api: {
      getConfig: () => runtimeConfig,
      isEnabled: () => resolvedOptions() !== false,
      refresh: refreshRuntimeConfig,
    },
    nitro: {
      name: "@vite-hub/database/cloudflare-bindings",
      setup(nitro) {
        nitroOptions = nitro.options
        mergeNitroCloudflareD1Bindings()
        nitro.hooks.hook("compiled", () => copyNitroMigrations(nitro.options.output.serverDir))
      },
    },
    vitehub: {
      cli: async () => {
        const db = resolvedOptions()
        if (db === false) return
        const contributor = createDbCliContributor(db?.cli, refreshRuntimeConfig)
        const provision = [createDatabaseProvisionStep(databaseRoot, db)]
        return contributor ? { ...contributor, provision } : { namespaces: [], provision }
      },
      inspect: () => {
        if (resolvedOptions() === false) return
        const runtime = runtimeConfig
        const rootDir = resolved?.root ?? process.cwd()
        const provisionState = readProvisionStateSync(rootDir)
        return {
          definitions: [{
            kind: "database",
            label: "Databases",
            list: () => inspectDatabaseDefinitions({
              projectRoot: resolveViteHubProjectRoot(resolved?.root ?? process.cwd()),
              rootDir: databaseRoot(),
              serverDirs: databaseServerDirs(),
            }),
          }],
          providerOutput: runtime ? [
            ...(shouldCreateCloudflareOutput(runtime, provisionState) ? [{ description: "Generated Cloudflare Database worker", owner: "database", path: resolve(createDefaultCloudflareOutputRoot(rootDir), "index.js") }] : []),
            ...(shouldCreateVercelOutput(runtime) ? [{ description: "Generated Vercel Database function", owner: "database", path: resolve(createDefaultVercelOutputRoot(rootDir), "functions", resolveNitroVercelFunctionName(resolved ?? {}, "database") ?? "__server.func", "index.mjs") }] : []),
          ] : [],
        }
      },
    },
    config(config) {
      serverDirs = (config as typeof config & { [VITEHUB_SERVER_DIRS]?: string[] })[VITEHUB_SERVER_DIRS] ?? serverDirs
    },
    async configResolved(config) {
      resolved = config
      providerOutput = useProviderOutputCatalog(config)
      await refreshRuntimeConfig()
      mergeNitroCloudflareD1Bindings()
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
      providerOutputGenerations.capture(this, providerOutput)
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
      const definitionDefaultsModule = context.server.moduleGraph.getModuleById(RESOLVED_DB_VIRTUAL_DEFINITION_DEFAULTS_ID)
      if (schemaModule) context.server.moduleGraph.invalidateModule(schemaModule)
      if (databasesModule) context.server.moduleGraph.invalidateModule(databasesModule)
      if (definitionDefaultsModule) context.server.moduleGraph.invalidateModule(definitionDefaultsModule)
    },
    async buildEnd(error) {
      if (error) {
        await providerOutputGenerations.reset(this, providerOutput, error)
        return
      }
      if (!resolved || !runtimeConfig || shouldSkipViteProviderBuild(resolved.command, getViteMode())) {
        return
      }

      let artifactDir: string | undefined
      try {
        const contributionResolved = resolved
        const contributionRuntimeConfig = runtimeConfig
        const contributionProviderOutput = providerOutput
        const generation = providerOutputGenerations.get(this)
        await writeGeneratedDatabaseArtifacts(contributionRuntimeConfig)
        artifactDir = resolve(contributionResolved.root, ".vitehub/database-generations", randomUUID())
        const contributionArtifactDir = artifactDir
        const retainedSources = await retainProviderOutputSources({
          artifactDir: resolve(contributionArtifactDir, "sources"),
          paths: [
            ...contributionRuntimeConfig.definitions.map(definition => definition.handler),
            ...Object.values(contributionRuntimeConfig.generatedSchemaFilesByDatabase),
          ],
          roots: [contributionResolved.root],
        })
        const retainedRuntimeConfig = {
          ...contributionRuntimeConfig,
          definitions: contributionRuntimeConfig.definitions.map(definition => ({
            ...definition,
            handler: retainedSources.resolve(definition.handler),
          })),
          generatedSchemaFilesByDatabase: Object.fromEntries(Object.entries(contributionRuntimeConfig.generatedSchemaFilesByDatabase)
            .map(([name, file]) => [name, retainedSources.resolve(file)])),
        }
        const contributionArtifacts = await prepareProviderOutputs({
          appRootDir: retainedSources.resolve(contributionResolved.root),
          artifactDir: resolve(contributionArtifactDir, "output"),
          generation,
          providerOutput: contributionProviderOutput,
          rootDir: databaseRoot(),
          runtimeConfig: retainedRuntimeConfig,
        })
        contributeProviderDeploymentOutput(contributionProviderOutput, {
          discard: async () => await removeProviderOutputArtifactDir(contributionArtifactDir),
          owner: "database",
          rootDir: contributionResolved.root,
          write: async ({ write }) => {
            await generateProviderOutputs({
              appRootDir: retainedSources.resolve(contributionResolved.root),
              artifacts: contributionArtifacts,
              clientOutDir: contributionResolved.build.outDir,
              generation,
              providerOutput: contributionProviderOutput,
              rootDir: contributionResolved.root,
              runtimeConfig: retainedRuntimeConfig,
              serverFunctionName: resolveNitroVercelFunctionName(contributionResolved, "database"),
            }, write)
          },
        }, generation)
      }
      catch (error) {
        if (artifactDir) await removeProviderOutputArtifactDir(artifactDir)
        await providerOutputGenerations.reset(this, providerOutput, error)
        throw error
      }
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
        return `export default ${JSON.stringify(runtimeConfig?.definitionDefaults ?? {
          ...(options && options.driver === "d1" ? { cloudflare: cloudflareOptions(options) ?? {} } : {}),
          ...(options && options.connection ? { connection: options.connection } : {}),
        })}\n`
      }
    },
    async renderError(error) {
      await providerOutputGenerations.reset(this, providerOutput, error)
    },
    closeBundle: {
      order: "post",
      sequential: true,
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
