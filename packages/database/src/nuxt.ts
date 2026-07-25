import { resolve } from "node:path"

import { resolveViteHubProjectRoot } from "@vite-hub/internal/build/vite"
import { isPlainObject as isRecord } from "@vite-hub/internal/object"

import { mergeCloudflareD1Bindings, resolveCloudflareD1Binding } from "./internal/cloudflare.ts"
import { hubDb as hubDbVite } from "./vite.ts"

import type { DatabaseNuxtIntegrationOptions, DBModulePublicOptions } from "./types.ts"
import type { Plugin } from "vite"

type ResolvedDatabaseNuxtIntegrationOptions = Exclude<DatabaseNuxtIntegrationOptions, false>

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
    dev?: boolean
    modules?: unknown[]
    nitro?: Record<string, unknown>
    rootDir?: string
    vite?: Record<string, unknown>
  }
}

interface ResolvedDatabaseNuxtD1Options {
  bindingName: string
  contentDatabase: { bindingName: string, type: "d1" } | { filename: string, type: "sqlite" }
  d1Database?: ReturnType<typeof resolveCloudflareD1Binding>["d1Database"]
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
    const viteOptions = resolveDatabaseViteOptions(resolvedOptions)
    if (viteOptions) {
      viteConfig.database = { ...(isRecord(viteConfig.database) ? viteConfig.database : {}), ...viteOptions }
    }
    installVitePlugin(viteConfig, { ...resolvedOptions, projectRoot: root })

    const d1 = resolveDatabaseNuxtD1Options(resolvedOptions, nuxtOptions)
    if (!d1) return

    mergeNuxtContentConfig(nuxtOptions, d1)
    mergeNitroCloudflareConfig(nuxtOptions, d1)

    const hook = (nuxt as NuxtLike).hook
    if (typeof hook === "function") {
      hook("nitro:config", (config) => {
        if (!nuxtOptions.dev) mergeNitroHostedCondition(config)
        mergeNitroRuntimeContentConfig(config, d1)
        mergeNitroConfigCloudflareConfig(config, d1)
      })
    }
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
  return Object.keys(viteOptions).length ? viteOptions : undefined
}

function resolveDatabaseNuxtD1Options(
  options: ResolvedDatabaseNuxtIntegrationOptions,
  nuxtOptions: NuxtLike["options"],
): ResolvedDatabaseNuxtD1Options | undefined {
  if (options.driver !== "d1") return

  const projection = resolveCloudflareD1Binding({
    binding: options.binding,
    database: "default",
    databaseId: options.databaseId,
    databaseName: options.databaseName,
    migrationsTable: options.migrationsTable,
    previewDatabaseId: options.previewDatabaseId,
  })

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
