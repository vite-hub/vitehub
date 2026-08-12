import { copyFile, mkdir, readdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { writeFileIfChanged } from "@vite-hub/internal/definition-catalog"
import { resolveViteHubGeneratedRoot, resolveViteHubProjectRoot, VITEHUB_GENERATED_ROOT } from "@vite-hub/internal/build/vite"
import { getHostingProvider } from "@vite-hub/internal/hosting"
import { isPlainObject as isRecord } from "@vite-hub/internal/object"
import { readProvisionStateSync } from "@vite-hub/internal/provision-state"

import { mergeCloudflareD1Bindings, resolveCloudflareD1Binding } from "./internal/cloudflare.ts"
import { renderDatabaseRuntimeModule } from "./internal/runtime-module.ts"
import { resolveDBViteConfig } from "./config.ts"
import { hubDb as hubDbVite } from "./vite.ts"

import type { DatabaseNuxtIntegrationOptions, DBModulePublicOptions } from "./types.ts"
import type { Plugin } from "vite"

type ResolvedDatabaseNuxtIntegrationOptions = Exclude<DatabaseNuxtIntegrationOptions, false>
const generatedNitroDatabaseMiddleware = ".vitehub/nitro/database/middleware.ts"
const generatedNitroLocalDatabaseRuntime = "database/local-runtime.mjs"
const generatedNitroMigrationsDir = ".vitehub/database/migrations"
const databaseDrizzleImport = "@vite-hub/database/drizzle"
const databaseRuntimeDir = fileURLToPath(new URL("./runtime/", import.meta.url))

type NuxtModuleDependencies = Record<string, {
  defaults?: Record<string, unknown>
  optional?: boolean
  overrides?: Record<string, unknown>
  version?: string
}>

type DatabaseNuxtModule = {
  (
    inlineOptions: DatabaseNuxtIntegrationOptions | undefined,
    nuxt: unknown,
  ): Promise<void> | void
  getMeta: () => {
    configKey: string
    name: string
  }
  getModuleDependencies: (nuxt: unknown) => NuxtModuleDependencies
}

type NuxtLike = {
  hook?: (name: string, callback: (value: Record<string, unknown>) => Promise<void> | void) => void
  options: Record<string, unknown> & {
    buildDir?: string
    dev?: boolean
    modules?: unknown[]
    nitro?: Record<string, unknown>
    rootDir?: string
    serverDir?: string
    srcDir?: string
    vite?: Record<string, unknown>
  }
}

interface ResolvedDatabaseNuxtD1Options {
  bindingName: string
  contentDatabase: { bindingName: string, type: "d1" } | { filename: string, type: "sqlite" }
  d1Database?: ReturnType<typeof resolveCloudflareD1Binding>["d1Database"]
  unresolved?: ReturnType<typeof resolveCloudflareD1Binding>["unresolved"]
  viteOptions: DBModulePublicOptions
}

export function hubDb(options: DatabaseNuxtIntegrationOptions = {}): DatabaseNuxtModule {
  const module = async function viteHubDatabaseNuxtModule(inlineOptions, nuxt) {
    const nuxtOptions = (nuxt as NuxtLike).options
    const resolvedOptions = resolveDatabaseNuxtOptions(options, inlineOptions, nuxtOptions)
    if (resolvedOptions === false) {
      return
    }

    const root = resolveViteHubProjectRoot(resolve(nuxtOptions.rootDir || process.cwd()), {
      projectRoot: resolvedOptions.projectRoot,
    })
    const viteConfig = ensureRecord(nuxtOptions, "vite")
    const generatedRoot = resolveViteHubGeneratedRoot({
      [VITEHUB_GENERATED_ROOT]: typeof viteConfig[VITEHUB_GENERATED_ROOT] === "string"
        ? viteConfig[VITEHUB_GENERATED_ROOT]
        : nuxtOptions.buildDir
          ? resolve(nuxtOptions.buildDir, "vitehub")
          : undefined,
      root,
    })
    const viteOptions = resolveDatabaseViteOptions(resolvedOptions)
    if (viteOptions) {
      viteConfig.database = { ...(isRecord(viteConfig.database) ? viteConfig.database : {}), ...viteOptions }
    }
    installVitePlugin(viteConfig, { ...resolvedOptions, projectRoot: root })

    const serverDirs = nuxtOptions.serverDir ? [nuxtOptions.serverDir] : undefined
    const databaseConfig = resolvedOptions.driver === "d1"
      ? resolveDBViteConfig(resolvedOptions, root, { serverDirs })
      : undefined
    const sourceMigrationsDir = databaseConfig && !databaseConfig.definitionCloudflareConfigured.default
      ? databaseConfig.databases.default?.migrationsDir
      : undefined
    const d1 = resolveDatabaseNuxtD1Options(
      resolvedOptions,
      nuxtOptions,
      sourceMigrationsDir ? generatedNitroMigrationsDir : undefined,
      readProvisionStateSync(root),
    )
    const hook = (nuxt as NuxtLike).hook
    if (typeof hook === "function") {
      hook("nitro:config", async (config) => {
        const provider = resolveNitroHostingProvider(config, nuxtOptions)
        if (!nuxtOptions.dev && provider === "cloudflare" && d1?.unresolved) {
          throw new TypeError(
            `[vitehub] Cloudflare D1 database ${JSON.stringify(d1.unresolved.database)} requires database.databaseId or provision state. Set database.databaseId or run \`vitehub provision run --provider cloudflare\`.`,
          )
        }
        if (!nuxtOptions.dev && (provider || d1)) mergeNitroHostedCondition(config)
        if (nuxtOptions.dev) {
          await installNitroLocalDatabaseRuntime(
            config,
            root,
            generatedRoot,
            resolvedOptions,
            serverDirs,
          )
        }
        if (!nuxtOptions.dev) {
          const runtimeRoot = typeof viteConfig.root === "string" ? viteConfig.root : nuxtOptions.srcDir || root
          mergeNitroDatabaseRuntimeAlias(config, runtimeRoot, provider ?? (d1 ? "cloudflare" : undefined))
        }
        if (!nuxtOptions.dev && provider === "cloudflare") {
          await installNitroCloudflareEnvBridge(config, root)
          if (sourceMigrationsDir) {
            installNitroCloudflareMigrations(config, resolve(root, sourceMigrationsDir))
          }
        }
        if (d1) {
          mergeNitroRuntimeContentConfig(config, d1)
          mergeNitroConfigCloudflareConfig(config, d1)
        }
      })
    }

    if (!d1) return
    mergeNuxtContentConfig(nuxtOptions, d1)
    mergeNitroCloudflareConfig(nuxtOptions, d1)
  } as DatabaseNuxtModule

  module.getMeta = () => ({
    configKey: "database",
    name: "@vite-hub/database/nuxt",
  })
  module.getModuleDependencies = nuxt => resolveNuxtContentModuleDependencies(options, nuxt)

  return module
}

const nuxtModule: DatabaseNuxtModule = hubDb()

export default nuxtModule

async function installNitroLocalDatabaseRuntime(
  config: Record<string, unknown>,
  root: string,
  generatedRoot: string,
  options: ResolvedDatabaseNuxtIntegrationOptions,
  serverDirs?: string[],
) {
  const file = resolve(generatedRoot, generatedNitroLocalDatabaseRuntime)
  const alias = isRecord(config.alias) ? config.alias : undefined
  const existingAlias = alias?.[databaseDrizzleImport]
  if (existingAlias && existingAlias !== file) {
    await rm(file, { force: true })
    return
  }

  const runtime = resolveDBViteConfig(options, root, { serverDirs })
  if (!runtime?.definitions.length) {
    await rm(file, { force: true })
    if (alias && existingAlias === file) {
      delete alias[databaseDrizzleImport]
      if (!Object.keys(alias).length) delete config.alias
    }
    return
  }

  const imports = runtime.definitions.map((definition, index) =>
    `import definition_${index} from ${JSON.stringify(pathToFileURL(definition.handler).href)}`)
  const entries = runtime.definitions.map((definition, index) => [
    `  ${JSON.stringify(definition.name)}: {`,
    `    db: createDefinitionRuntime(definition_${index}, definitionDefaults),`,
    `    schema: definition_${index}.schema,`,
    "  },",
  ].join("\n"))
  await writeFileIfChanged(file, renderDatabaseRuntimeModule({
    createAgentDatabaseImport: pathToFileURL(resolve(databaseRuntimeDir, "agent.js")).href,
    databaseEntries: entries,
    imports: [
      `import { createDefinitionRuntime } from ${JSON.stringify(pathToFileURL(resolve(databaseRuntimeDir, "definition-local.js")).href)}`,
      ...imports,
      "",
      `const definitionDefaults = ${JSON.stringify(runtime.definitionDefaults)}`,
    ],
  }))
  if (alias) alias[databaseDrizzleImport] = file
  else config.alias = { [databaseDrizzleImport]: file }
}

function resolveNuxtContentModuleDependencies(options: DatabaseNuxtIntegrationOptions, nuxt: unknown): NuxtModuleDependencies {
  const nuxtOptions = (nuxt as NuxtLike).options
  const resolvedOptions = resolveDatabaseNuxtOptions(options, undefined, nuxtOptions)
  if (resolvedOptions === false || !hasNuxtContentModule(nuxtOptions.modules)) {
    return {}
  }

  const d1 = resolveDatabaseNuxtD1Options(resolvedOptions, nuxtOptions)
  if (!d1) return {}

  return {
    "@nuxt/content": {
      overrides: {
        database: d1.contentDatabase,
      },
    },
  }
}

function resolveDatabaseNuxtOptions(
  options: DatabaseNuxtIntegrationOptions,
  inlineOptions: DatabaseNuxtIntegrationOptions | undefined,
  nuxtOptions: NuxtLike["options"],
): ResolvedDatabaseNuxtIntegrationOptions | false {
  if (options === false || inlineOptions === false || nuxtOptions.database === false) {
    return false
  }
  return {
    ...(isRecord(nuxtOptions.database) ? nuxtOptions.database : {}),
    ...(isRecord(options) ? options : {}),
    ...(isRecord(inlineOptions) ? inlineOptions : {}),
  } as ResolvedDatabaseNuxtIntegrationOptions
}

function resolveDatabaseViteOptions(options: ResolvedDatabaseNuxtIntegrationOptions): DBModulePublicOptions | undefined {
  const viteOptions: Exclude<DBModulePublicOptions, false> = {}
  if ("cli" in options) {
    viteOptions.cli = options.cli
  }
  if (options.connection) {
    viteOptions.connection = options.connection
  }
  if (options.driver === "d1") {
    viteOptions.driver = "d1"
    viteOptions.binding = options.binding
    viteOptions.databaseId = options.databaseId
    viteOptions.databaseName = options.databaseName
    viteOptions.local = options.local
    viteOptions.migrationsTable = options.migrationsTable
    viteOptions.previewDatabaseId = options.previewDatabaseId
  }
  return Object.keys(viteOptions).length ? viteOptions : undefined
}

function resolveDatabaseNuxtD1Options(
  options: ResolvedDatabaseNuxtIntegrationOptions,
  nuxtOptions: NuxtLike["options"],
  migrationsDir?: string,
  provisionState?: NonNullable<Parameters<typeof resolveCloudflareD1Binding>[1]>["provisionState"],
): ResolvedDatabaseNuxtD1Options | undefined {
  if (options.driver !== "d1") return

  const projection = resolveCloudflareD1Binding({
    binding: options.binding,
    database: "default",
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    migrationsDir,
    migrationsTable: options.migrationsTable,
    previewDatabaseId: options.previewDatabaseId,
  }, { provisionState })

  return {
    bindingName: projection.bindingName,
    contentDatabase: nuxtOptions.dev
      ? {
          type: "sqlite",
          filename: options.local?.filename ?? ".data/content.sqlite",
        }
      : {
          type: "d1",
          bindingName: projection.bindingName,
        },
    ...(projection.d1Database ? { d1Database: projection.d1Database } : {}),
    ...(projection.unresolved ? { unresolved: projection.unresolved } : {}),
    viteOptions: resolveDatabaseViteOptions(options) ?? {},
  }
}

function installVitePlugin(viteConfig: Record<string, unknown>, options: ResolvedDatabaseNuxtIntegrationOptions) {
  const plugins = Array.isArray(viteConfig.plugins) ? viteConfig.plugins : []
  if (!plugins.some(plugin => isRecord(plugin) && plugin.name === "@vite-hub/database/vite")) {
    viteConfig.plugins = [hubDbVite(resolveDatabaseViteOptions(options)), ...plugins] satisfies Plugin[]
  }
}

function mergeNuxtContentConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  const content = ensureRecord(config, "content")
  content.database = d1.contentDatabase
}

function mergeNitroRuntimeContentConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  const runtimeConfig = ensureRecord(config, "runtimeConfig")
  const content = ensureRecord(runtimeConfig, "content")
  content.database = d1.contentDatabase
}

function mergeNitroHostedCondition(config: Record<string, unknown>) {
  const conditions = Array.isArray(config.exportConditions) ? config.exportConditions : []
  if (!conditions.includes("vitehub-hosted")) {
    config.exportConditions = ["vitehub-hosted", ...conditions]
  }
}

function mergeNitroDatabaseRuntimeAlias(
  config: Record<string, unknown>,
  root: string,
  provider: string | undefined,
) {
  if (provider !== "cloudflare" && provider !== "vercel") return
  const alias = ensureRecord(config, "alias")
  if (!(databaseDrizzleImport in alias)) {
    alias[databaseDrizzleImport] = resolve(root, `.vitehub/database/${provider}-runtime.mjs`)
  }
}

function resolveNitroHostingProvider(config: Record<string, unknown>, nuxtOptions: NuxtLike["options"]) {
  const preset = typeof config.preset === "string"
    ? config.preset
    : typeof nuxtOptions.nitro?.preset === "string"
      ? nuxtOptions.nitro.preset
      : process.env.NITRO_PRESET || process.env.SERVER_PRESET || process.env.VITEHUB_HOSTING
  return getHostingProvider(preset) ?? (typeof preset === "string" && /^deno(?:-|$)/.test(preset) ? "deno" : undefined)
}

async function installNitroCloudflareEnvBridge(config: Record<string, unknown>, root: string) {
  const handlers = Array.isArray(config.handlers) ? [...config.handlers] : []
  if (!handlers.some(handler => isRecord(handler) && handler.handler === generatedNitroDatabaseMiddleware)) {
    handlers.unshift({ handler: generatedNitroDatabaseMiddleware, middleware: true, route: "/**" })
  }
  config.handlers = handlers
  const rollupConfig = isRecord(config.rollupConfig) ? { ...config.rollupConfig } : {}
  rollupConfig.external = mergeNitroExternal(rollupConfig.external, "cloudflare:workers")
  config.rollupConfig = rollupConfig
  await writeFileIfChanged(resolve(root, generatedNitroDatabaseMiddleware), [
    "import { env as vitehubEnv } from 'cloudflare:workers'",
    "import { setActiveCloudflareEnv } from '@vite-hub/database/runtime/state'",
    "",
    "export default (event: unknown) => {",
    "  const target = event as { env?: Record<string, unknown>, context?: { cloudflare?: { env?: Record<string, unknown> }, _platform?: { cloudflare?: { env?: Record<string, unknown> } } }, req?: { runtime?: { cloudflare?: { env?: Record<string, unknown> } } } }",
    "  setActiveCloudflareEnv({ ...(vitehubEnv as unknown as Record<string, unknown>), ...target.req?.runtime?.cloudflare?.env, ...target.context?._platform?.cloudflare?.env, ...target.context?.cloudflare?.env, ...target.env })",
    "}",
    "",
  ].join("\n"))
}

function installNitroCloudflareMigrations(config: Record<string, unknown>, sourceDir: string) {
  const modules = Array.isArray(config.modules) ? [...config.modules] : []
  modules.push((nitro: {
    hooks: { hook: (name: "compiled", callback: () => Promise<void>) => void }
    options: { output: { serverDir: string } }
  }) => {
    nitro.hooks.hook("compiled", async () => {
      const outputDir = resolve(nitro.options.output.serverDir, generatedNitroMigrationsDir)
      const entries = await readdir(sourceDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return []
        throw error
      })
      await rm(outputDir, { force: true, recursive: true })
      await mkdir(outputDir, { recursive: true })
      await Promise.all(entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".sql"))
        .map(entry => copyFile(resolve(sourceDir, entry.name), resolve(outputDir, entry.name))))
    })
  })
  config.modules = modules
}

function mergeNitroExternal(value: unknown, addition: string): unknown {
  if (typeof value === "undefined") return [addition]
  if (Array.isArray(value)) return value.includes(addition) ? [...value] : [...value, addition]
  if (typeof value === "string" || value instanceof RegExp) return [value, addition]
  if (typeof value === "function") {
    return (source: string, importer?: string, isResolved?: boolean) => source === addition || Boolean(value(source, importer, isResolved))
  }
  return value
}

function mergeNitroCloudflareConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  if (!d1.d1Database) return
  const nitro = ensureRecord(config, "nitro")
  const cloudflare = ensureRecord(nitro, "cloudflare")
  const wrangler = ensureRecord(cloudflare, "wrangler")
  wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, [d1.d1Database])
}

function mergeNitroConfigCloudflareConfig(config: Record<string, unknown>, d1: ResolvedDatabaseNuxtD1Options) {
  if (!d1.d1Database) return
  const cloudflare = ensureRecord(config, "cloudflare")
  const wrangler = ensureRecord(cloudflare, "wrangler")
  wrangler.d1_databases = mergeCloudflareD1Bindings(wrangler.d1_databases, [d1.d1Database])
}

function hasNuxtContentModule(modules: unknown[] | undefined) {
  return Array.isArray(modules) && modules.some((module) => {
    const value = Array.isArray(module) ? module[0] : module
    return value === "@nuxt/content"
  })
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  if (isRecord(value)) return value
  const record: Record<string, unknown> = {}
  parent[key] = record
  return record
}
