import { mkdir, rm, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { copyClientOutput, hasStaticIndex } from "@vitehub/internal/build/client-output"
import { defaultCloudflareCompatibilityDate } from "@vitehub/internal/build/cloudflare"
import { bundleEsmEntry } from "@vitehub/internal/build/esbuild"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vitehub/internal/build/paths"
import { resolveUserAppEntry, toSafeAppName } from "@vitehub/internal/build/user-entry"
import { createNodeFunctionConfig, createVercelConfigJson } from "@vitehub/internal/build/vercel-config"

import { serializeSchemaObject } from "./schema-serializer.ts"

import type { ResolvedDBViteConfig, ResolvedDrizzleDatabaseConfig } from "../types.ts"

export const dbPackageName = "@vitehub/db"
const productName = "db"
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

function renderRuntimeModule(file: string, runtimeConfig: ResolvedDBViteConfig) {
  const schemaBlocks = runtimeConfig.databaseNames.map((name, index) => serializeSchemaObject(
    runtimeConfig.schemaPathsByDatabase[name] || [],
    `schema_${index}`,
    name === "default",
  ))
  const databaseEntries = runtimeConfig.databaseNames.map((name, index) => [
    `  ${JSON.stringify(name)}: {`,
    `    db: createHostedDrizzleDb(${serializeDatabaseConfig(runtimeConfig.databases[name]!)}, schema_${index}),`,
    `    schema: schema_${index},`,
    "  },",
  ].join("\n"))

  return [
    `import { createHostedDrizzleDb } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/hosted")))}`,
    "",
    ...schemaBlocks,
    "export const databases = {",
    ...databaseEntries,
    "}",
    "",
    "export const db = databases.default.db",
    "export const schema = databases.default.schema",
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
    .filter((database): database is NonNullable<ResolvedDBViteConfig["databases"][string]["cloudflare"]> => Boolean(database?.databaseId))
    .map(database => ({
      binding: database.binding,
      database_id: database.databaseId!,
      ...(database.databaseName ? { database_name: database.databaseName } : {}),
      ...(database.migrationsDir ? { migrations_dir: database.migrationsDir } : {}),
      ...(database.migrationsTable ? { migrations_table: database.migrationsTable } : {}),
      ...(database.previewDatabaseId ? { preview_database_id: database.previewDatabaseId } : {}),
    }))
}

function isRemoteLibsqlConnectionUrl(url: string | undefined) {
  return typeof url === "string" && /^(?:libsql:|https?:\/\/)/i.test(url)
}

function getVercelUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    return !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

interface ProviderWriteOptions {
  artifacts: GeneratedDBArtifacts
  clientOutDir: string
  rootDir: string
  runtimeConfig: ResolvedDBViteConfig
}

async function writeCloudflareOutput({ artifacts, clientOutDir, rootDir, runtimeConfig }: ProviderWriteOptions) {
  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, "dist", toSafeAppName(rootDir))
  const workerOutfile = resolve(outputRoot, "index.js")
  const staticIndex = hasStaticIndex(clientDir)
  const d1Databases = createCloudflareD1Bindings(runtimeConfig)

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(outputRoot, { recursive: true })

  const wranglerConfig: CloudflareDBConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    ...(d1Databases.length ? { d1_databases: d1Databases } : {}),
    main: "index.js",
    name: toSafeAppName(rootDir),
    observability: { enabled: true },
    ...(staticIndex ? { assets: { directory: "../client", run_worker_first: ["/api/*"] } } : {}),
  }

  await Promise.all([
    bundleEsmEntry(artifacts.cloudflareWorkerFile, workerOutfile, {
      alias: { "@vitehub/db/drizzle": artifacts.runtimeModuleFiles.cloudflare },
      conditions: ["workerd", "worker", "browser", "default"],
      external: ["node:async_hooks"],
      format: "esm",
      platform: "neutral",
    }),
    writeFile(resolve(outputRoot, "wrangler.json"), `${JSON.stringify(wranglerConfig, null, 2)}\n`, "utf8"),
    staticIndex ? copyClientOutput(clientDir, resolve(rootDir, "dist", "client")) : Promise.resolve(),
  ])
}

async function writeVercelOutput({ artifacts, clientOutDir, rootDir, runtimeConfig }: ProviderWriteOptions) {
  const unsupportedDatabases = getVercelUnsupportedDatabases(runtimeConfig)
  if (unsupportedDatabases.length) {
    throw new Error(`[vitehub] Vercel output requires a remote libSQL \`db.connection.url\` for databases: ${unsupportedDatabases.join(", ")}.`)
  }

  const clientDir = resolve(rootDir, clientOutDir)
  const outputRoot = resolve(rootDir, ".vercel", "output")
  const serverDir = resolve(outputRoot, "functions", "__server.func")
  const serverEntry = resolve(serverDir, "index.mjs")
  const staticIndex = hasStaticIndex(clientDir)

  await rm(outputRoot, { force: true, recursive: true })
  await mkdir(serverDir, { recursive: true })

  await Promise.all([
    bundleEsmEntry(artifacts.vercelServerFile, serverEntry, {
      alias: { "@vitehub/db/drizzle": artifacts.runtimeModuleFiles.vercel },
      format: "esm",
      platform: "node",
    }),
    writeFile(resolve(serverDir, ".vc-config.json"), `${JSON.stringify(createNodeFunctionConfig(), null, 2)}\n`, "utf8"),
    writeFile(resolve(outputRoot, "config.json"), `${JSON.stringify(createVercelConfigJson(), null, 2)}\n`, "utf8"),
    staticIndex ? copyClientOutput(clientDir, resolve(outputRoot, "static")) : Promise.resolve(),
  ])
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedDBArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.runtimeConfig)
  const writeOptions: ProviderWriteOptions = { artifacts, ...options }
  await Promise.all([writeCloudflareOutput(writeOptions), writeVercelOutput(writeOptions)])
  return artifacts
}
