import { mkdir, writeFile } from "node:fs/promises"

import { writeProviderDeploymentOutputs } from "@vitehub/internal/build/deployment-output"
import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { resolveUserAppEntry } from "@vitehub/internal/build/user-entry"
import { resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, VercelProviderDeploymentOutput } from "@vitehub/internal/build/deployment-output"

export const dbPackageName = "@vitehub/database"
const productName = "database"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

type DBProvider = "cloudflare" | "vercel"

interface ProviderEntrySpec {
  entryFile: string
  factory: string
  name: DBProvider
  runtimeModule: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { entryFile: "cloudflare-worker.mjs", factory: "createDbCloudflareWorker", name: "cloudflare", runtimeModule: "runtime/cloudflare-vite" },
  { entryFile: "vercel-server.mjs", factory: "createDbVercelServer", name: "vercel", runtimeModule: "runtime/vercel-vite" },
]

interface GenerateProviderOutputsOptions {
  clientOutDir: string
  rootDir: string
  runtimeConfig: ResolvedDBViteConfig
}

interface GeneratedDBArtifacts {
  cloudflareWorkerFile: string
  generatedDir: string
  runtimeModuleFiles: Record<DBProvider, string>
  vercelServerFile: string
}

interface CloudflareDBBindingConfig {
  binding: string
  database_id: string
  database_name?: string
  migrations_dir?: string
  migrations_table?: string
  preview_database_id?: string
}

interface CloudflareDBConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  d1_databases?: CloudflareDBBindingConfig[]
  main: string
  name?: string
  observability: { enabled: true }
}

function serializeDatabaseConfig(database: ResolvedDrizzleDatabaseConfig) {
  return JSON.stringify(database, null, 4)
}

function getDefaultCloudflareBindingName(name: string) {
  if (name === "default") return "DB"
  const suffix = name
    .replace(/[^a-z0-9]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toUpperCase()
  return `DB_${suffix || "DATABASE"}`
}

function renderDatabaseConfigExpression(name: string, runtimeConfig: ResolvedDBViteConfig, definitionVariable: string) {
  const base = runtimeConfig.databases[name]!
  return [
    "{",
    `      ...${serializeDatabaseConfig(base)},`,
    `      cloudflare: ${definitionVariable}.cloudflare ? { ...${definitionVariable}.cloudflare, binding: ${definitionVariable}.cloudflare.binding ?? ${JSON.stringify(base.cloudflare?.binding ?? getDefaultCloudflareBindingName(name))}, migrationsDir: ${JSON.stringify(base.migrationsDir)} } : undefined,`,
    `      connection: ${definitionVariable}.connection ? { ...${JSON.stringify(base.connection)}, ...${definitionVariable}.connection, authToken: ${definitionVariable}.connection.authToken ?? ${JSON.stringify(base.connection?.authToken)}, url: ${definitionVariable}.connection.url ?? ${JSON.stringify(base.connection?.url)} } : ${JSON.stringify(base.connection)},`,
    `      drizzle: ${definitionVariable}.drizzle ?? {},`,
    "    }",
  ].join("\n")
}

function renderRuntimeModule(file: string, runtimeConfig: ResolvedDBViteConfig) {
  const imports = runtimeConfig.definitions.flatMap((definition, index) => [
    `import definition_${index} from ${JSON.stringify(createImportPath(file, definition.handler))}`,
    `import schema_${index} from ${JSON.stringify(createImportPath(file, runtimeConfig.generatedSchemaFilesByDatabase[definition.name]!))}`,
  ])
  const databaseEntries = runtimeConfig.databaseNames.map((name, index) => [
    `  ${JSON.stringify(name)}: {`,
    `    db: createHostedDrizzleDb(${renderDatabaseConfigExpression(name, runtimeConfig, `definition_${index}`)}, schema_${index}),`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    `import { createHostedDrizzleDb } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    "",
    ...imports,
    "",
    "export const databases = {",
    ...databaseEntries,
    "}",
    "",
    ...(runtimeConfig.databaseNames.includes("default")
      ? [
          "export const db = databases.default.db",
          "export const schema = databases.default.schema",
        ]
      : []),
    "",
  ].join("\n")
}

function renderProviderEntry(spec: ProviderEntrySpec, entryFile: string, userAppEntry: string | undefined) {
  const imports = [
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
  ]
  if (userAppEntry) {
    imports.push(`import dbApp from ${JSON.stringify(createImportPath(entryFile, userAppEntry))}`)
  }

  return [
    ...imports,
    "",
    `export default ${spec.factory}({`,
    userAppEntry ? "  app: dbApp," : "",
    "})",
    "",
  ].filter(Boolean).join("\n")
}

async function writeProviderEntries(rootDir: string, runtimeConfig: ResolvedDBViteConfig): Promise<GeneratedDBArtifacts> {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const userAppEntry = resolveUserAppEntry(rootDir, {
    names: ["server.db.ts", "server.db.mts", "server.db.js", "server.db.mjs", "server.ts", "server.mts", "server.js", "server.mjs"],
  })
  const entryFiles: Record<DBProvider, string> = { cloudflare: "", vercel: "" }
  const runtimeModuleFiles: Record<DBProvider, string> = { cloudflare: "", vercel: "" }

  await Promise.all(providerEntrySpecs.map(async (spec) => {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const runtimeModuleFile = resolve(generatedDir, `${spec.name}-runtime.mjs`)
    entryFiles[spec.name] = entryFile
    runtimeModuleFiles[spec.name] = runtimeModuleFile
    await Promise.all([
      writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry), "utf8"),
      writeFile(runtimeModuleFile, renderRuntimeModule(runtimeModuleFile, runtimeConfig), "utf8"),
    ])
  }))

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    generatedDir,
    runtimeModuleFiles,
    vercelServerFile: entryFiles.vercel,
  }
}

function createCloudflareD1Bindings(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames
    .map(name => runtimeConfig.databases[name]?.cloudflare)
    .filter((database): database is NonNullable<ResolvedDBViteConfig["databases"][string]["cloudflare"]> => Boolean(resolveConfigValue(database?.databaseId)))
    .map(database => ({
      binding: database.binding,
      database_name: resolveConfigValue(database.databaseName)!,
      database_id: resolveConfigValue(database.databaseId)!,
      ...(database.migrationsDir ? { migrations_dir: database.migrationsDir } : {}),
      ...(database.migrationsTable ? { migrations_table: database.migrationsTable } : {}),
      ...(resolveConfigValue(database.previewDatabaseId) ? { preview_database_id: resolveConfigValue(database.previewDatabaseId) } : {}),
    }))
}

function isRemoteLibsqlConnectionUrl(url: string | undefined) {
  return typeof url === "string" && /^(?:libsql:|https?:\/\/)/i.test(url)
}

function getCloudflareUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    const hasD1Binding = Boolean(resolveConfigValue(database?.cloudflare?.databaseId))
    return !hasD1Binding && !isRemoteLibsqlConnectionUrl(resolveConfigValue(database?.connection?.url))
  })
}

function getCloudflareDatabasesMissingNames(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const cloudflare = runtimeConfig.databases[name]?.cloudflare
    return Boolean(resolveConfigValue(cloudflare?.databaseId)) && !resolveConfigValue(cloudflare?.databaseName)
  })
}

function getVercelUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    return !isRemoteLibsqlConnectionUrl(resolveConfigValue(database?.connection?.url))
  })
}

interface ProviderWriteOptions {
  artifacts: GeneratedDBArtifacts
  clientOutDir: string
  rootDir: string
  runtimeConfig: ResolvedDBViteConfig
}

function createCloudflareOutput({ artifacts, runtimeConfig }: ProviderWriteOptions): CloudflareProviderDeploymentOutput {
  const databasesMissingNames = getCloudflareDatabasesMissingNames(runtimeConfig)
  if (databasesMissingNames.length) {
    throw new Error(`[vitehub] Cloudflare output requires \`db.cloudflare.databaseName\` when \`db.cloudflare.databaseId\` is set for databases: ${databasesMissingNames.join(", ")}.`)
  }

  const unsupportedDatabases = getCloudflareUnsupportedDatabases(runtimeConfig)
  if (unsupportedDatabases.length) {
    throw new Error(`[vitehub] Cloudflare output requires \`db.cloudflare.databaseId\` or a remote libSQL \`db.connection.url\` for databases: ${unsupportedDatabases.join(", ")}.`)
  }

  const d1Databases = createCloudflareD1Bindings(runtimeConfig)

  const wranglerConfig: CloudflareDBConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    ...(d1Databases.length ? { d1_databases: d1Databases } : {}),
    main: "index.js",
    observability: { enabled: true },
  }

  return {
    bundleEntry: artifacts.cloudflareWorkerFile,
    bundleOptions: {
      alias: { "@vitehub/database/drizzle": artifacts.runtimeModuleFiles.cloudflare },
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["node:async_hooks"],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfig,
  }
}

function createVercelOutput({ artifacts, runtimeConfig }: ProviderWriteOptions): VercelProviderDeploymentOutput {
  const unsupportedDatabases = getVercelUnsupportedDatabases(runtimeConfig)
  if (unsupportedDatabases.length) {
    throw new Error(`[vitehub] Vercel output requires a remote libSQL \`db.connection.url\` for databases: ${unsupportedDatabases.join(", ")}.`)
  }

  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: { "@vitehub/database/drizzle": artifacts.runtimeModuleFiles.vercel },
      format: "esm",
      platform: "node",
    },
  }
}

function shouldCreateVercelOutput(runtimeConfig: ResolvedDBViteConfig) {
  return getVercelUnsupportedDatabases(runtimeConfig).length === 0
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedDBArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.runtimeConfig)
  const writeOptions: ProviderWriteOptions = { artifacts, ...options }
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflareOutput(writeOptions),
    rootDir: options.rootDir,
    vercel: shouldCreateVercelOutput(options.runtimeConfig) ? createVercelOutput(writeOptions) : undefined,
  })
  return artifacts
}
