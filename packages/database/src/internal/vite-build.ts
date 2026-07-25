import { mkdir, writeFile } from "node:fs/promises"

import { getProviderRuntimeModule, registerProviderRuntimeModules, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { readProvisionedId, readProvisionStateSync } from "@vite-hub/internal/provision-state"
import { resolve } from "pathe"

import { resolveConfigValue } from "../config-value.ts"
import { resolveCloudflareD1Bindings } from "./cloudflare.ts"
import { renderDatabaseConfigExpression } from "./runtime-config-expression.ts"

import type { ProvisionState } from "@vite-hub/internal/provision"
import type { DatabaseConfigValue, ResolvedDBViteConfig } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ComposedProviderOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"

export const dbPackageName = "@vite-hub/database"
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
  artifacts?: GeneratedDBArtifacts
  clientOutDir: string
  providerOutput?: ComposedProviderOutput
  rootDir: string
  runtimeConfig: ResolvedDBViteConfig
  serverFunctionName?: string
}

interface GeneratedDBArtifacts {
  cloudflareWorkerFile: string
  definitionDefaultsFile: string
  generatedDir: string
  runtimeModuleFiles: Record<DBProvider, string>
  vercelServerFile: string
}

interface CloudflareDBConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  d1_databases?: ReturnType<typeof resolveCloudflareD1Bindings>["d1Databases"]
  main: string
  name?: string
  observability: { enabled: true }
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
  const definitionDefaultsFile = resolve(generatedDir, "definition-defaults.mjs")

  await Promise.all([writeFile(
    definitionDefaultsFile,
    `export default ${JSON.stringify(runtimeConfig.definitionDefaults)}\n`,
    "utf8",
  ), ...providerEntrySpecs.map(async (spec) => {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const runtimeModuleFile = resolve(generatedDir, `${spec.name}-runtime.mjs`)
    entryFiles[spec.name] = entryFile
    runtimeModuleFiles[spec.name] = runtimeModuleFile
    await Promise.all([
      writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry), "utf8"),
      writeFile(runtimeModuleFile, renderRuntimeModule(runtimeModuleFile, runtimeConfig), "utf8"),
    ])
  })])

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    definitionDefaultsFile,
    generatedDir,
    runtimeModuleFiles,
    vercelServerFile: entryFiles.vercel,
  }
}

// Explicit env-resolved id wins; otherwise fall back to a provisioned id from Provision State.
function resolveDatabaseId(runtimeConfig: ResolvedDBViteConfig, name: string, provisionState: ProvisionState): string | undefined {
  return resolveConfigValue(runtimeConfig.databases[name]?.cloudflare?.databaseId)
    ?? readProvisionedId(provisionState, "cloudflare", "d1", name)
}

function isRemoteLibsqlConnectionUrl(value: DatabaseConfigValue | undefined) {
  const url = resolveConfigValue(value)
  return typeof url === "string"
    ? /^(?:libsql:|https?:\/\/)/i.test(url)
    : typeof value !== "undefined"
}

function hasConfigValue(value: DatabaseConfigValue | undefined) {
  const databaseId = resolveConfigValue(value)
  return typeof databaseId === "string"
    ? Boolean(databaseId.trim())
    : typeof value !== "undefined"
}

function getCloudflareUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    const hasD1Binding = Boolean(resolveDatabaseId(runtimeConfig, name, provisionState))
    return !hasD1Binding && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

function getCloudflareDatabasesMissingNames(runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return runtimeConfig.databaseNames.filter((name) => {
    const cloudflare = runtimeConfig.databases[name]?.cloudflare
    return Boolean(resolveDatabaseId(runtimeConfig, name, provisionState)) && !resolveConfigValue(cloudflare?.databaseName)
  })
}

function getVercelUnsupportedDatabases(runtimeConfig: ResolvedDBViteConfig) {
  return runtimeConfig.databaseNames.filter((name) => {
    const database = runtimeConfig.databases[name]
    const hasD1Http = Boolean(database?.cloudflare?.http)
      && hasConfigValue(database.cloudflare?.databaseId)
    return !hasD1Http
      && !isRemoteLibsqlConnectionUrl(database?.connection?.url)
  })
}

interface ProviderWriteOptions {
  artifacts: GeneratedDBArtifacts
  clientOutDir: string
  providerOutput?: ComposedProviderOutput
  provisionState: ProvisionState
  rootDir: string
  runtimeConfig: ResolvedDBViteConfig
  serverFunctionName?: string
}

function createCloudflareOutput({ artifacts, providerOutput, provisionState, runtimeConfig }: ProviderWriteOptions): CloudflareProviderDeploymentOutput {
  const databasesMissingNames = getCloudflareDatabasesMissingNames(runtimeConfig, provisionState)
  if (databasesMissingNames.length) {
    throw new Error(`[vitehub] Cloudflare output requires \`db.cloudflare.databaseName\` when \`db.cloudflare.databaseId\` is set for databases: ${databasesMissingNames.join(", ")}.`)
  }

  const unsupportedDatabases = getCloudflareUnsupportedDatabases(runtimeConfig, provisionState)
  if (unsupportedDatabases.length) {
    throw new Error(`[vitehub] Cloudflare output requires \`db.cloudflare.databaseId\` or a remote libSQL \`db.connection.url\` for databases: ${unsupportedDatabases.join(", ")}.`)
  }

  const d1Databases = resolveCloudflareD1Bindings(runtimeConfig, { provisionState }).d1Databases
  const blobRuntime = getProviderRuntimeModule(providerOutput, "blob", "cloudflare")

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
      alias: {
        "#vitehub/database/definition-defaults": artifacts.definitionDefaultsFile,
        "@vite-hub/database/drizzle": artifacts.runtimeModuleFiles.cloudflare,
        ...(blobRuntime ? { "@vite-hub/blob": blobRuntime } : {}),
      },
      conditions: ["vitehub-hosted", "workerd", "worker", "browser", "default"],
      external: ["node:async_hooks"],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfigKeys: ["d1_databases"],
    wranglerConfig,
  }
}

function createVercelOutput({ artifacts, providerOutput, runtimeConfig, serverFunctionName }: ProviderWriteOptions): VercelProviderDeploymentOutput {
  const unsupportedDatabases = getVercelUnsupportedDatabases(runtimeConfig)
  if (unsupportedDatabases.length) {
    throw new Error(`[vitehub] Vercel output requires \`db.cloudflare.http\` with \`db.cloudflare.databaseId\`, or a remote libSQL \`db.connection.url\`, for databases: ${unsupportedDatabases.join(", ")}.`)
  }
  const blobRuntime = getProviderRuntimeModule(providerOutput, "blob", "vercel")

  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: {
        "#vitehub/database/definition-defaults": artifacts.definitionDefaultsFile,
        "@vite-hub/database/drizzle": artifacts.runtimeModuleFiles.vercel,
        ...(blobRuntime ? { "@vite-hub/blob": blobRuntime } : {}),
      },
      conditions: ["vitehub-hosted", "node", "default"],
      format: "esm",
      platform: "node",
    },
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

function shouldCreateVercelOutput(runtimeConfig: ResolvedDBViteConfig) {
  return getVercelUnsupportedDatabases(runtimeConfig).length === 0
}

function shouldCreateCloudflareOutput(runtimeConfig: ResolvedDBViteConfig, provisionState: ProvisionState) {
  return getCloudflareUnsupportedDatabases(runtimeConfig, provisionState).length === 0
    && getCloudflareDatabasesMissingNames(runtimeConfig, provisionState).length === 0
}

function getSupportedProviderRuntimeModules(
  artifacts: GeneratedDBArtifacts,
  runtimeConfig: ResolvedDBViteConfig,
  provisionState: ProvisionState,
): Record<string, string> {
  return {
    ...(shouldCreateCloudflareOutput(runtimeConfig, provisionState) ? { cloudflare: artifacts.runtimeModuleFiles.cloudflare } : {}),
    ...(shouldCreateVercelOutput(runtimeConfig) ? { vercel: artifacts.runtimeModuleFiles.vercel } : {}),
  }
}

function registerSupportedProviderRuntimeModules(
  providerOutput: ComposedProviderOutput | undefined,
  artifacts: GeneratedDBArtifacts,
  runtimeConfig: ResolvedDBViteConfig,
  provisionState: ProvisionState,
): void {
  registerProviderRuntimeModules(providerOutput, productName, getSupportedProviderRuntimeModules(artifacts, runtimeConfig, provisionState))
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedDBArtifacts> {
  const artifacts = options.artifacts ?? await prepareProviderOutputs(options)
  const provisionState = readProvisionStateSync(options.rootDir)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.runtimeConfig, provisionState)
  const writeOptions: ProviderWriteOptions = { artifacts, provisionState, ...options }
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: shouldCreateCloudflareOutput(options.runtimeConfig, provisionState) ? createCloudflareOutput(writeOptions) : undefined,
    cleanup: {
      cloudflare: () => {
        const hasOtherCloudflareOutput = Object.entries(options.providerOutput?.runtimeModuleFilesByProduct ?? {})
          .some(([product, modules]) => product !== productName && Boolean(modules?.cloudflare))
        return {
          ...(!hasOtherCloudflareOutput ? { fileNames: ["index.js"] } : {}),
          wranglerConfigOwnership: { keys: ["d1_databases"] },
        }
      },
    },
    rootDir: options.rootDir,
    vercel: shouldCreateVercelOutput(options.runtimeConfig) ? createVercelOutput(writeOptions) : undefined,
  })
  return artifacts
}

export async function prepareProviderOutputs(options: Pick<GenerateProviderOutputsOptions, "providerOutput" | "rootDir" | "runtimeConfig">): Promise<GeneratedDBArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.runtimeConfig)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.runtimeConfig, readProvisionStateSync(options.rootDir))
  return artifacts
}
