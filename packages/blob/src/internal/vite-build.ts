import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "pathe"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { getProviderRuntimeModule, registerProviderRuntimeModules, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"

import { normalizeBlobOptions } from "../config.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ComposedProviderOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"

export const blobPackageName = "@vite-hub/blob"
const productName = "blob"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

const BLOB_ENTRY_NAMES_DEFAULT = ["server.ts", "server.mts", "server.js", "server.mjs", "worker.ts", "worker.mts", "worker.js", "worker.mjs"] as const
const BLOB_ENTRY_NAMES_PRIORITIZED = ["server.blob.ts", "server.blob.mts", "server.blob.js", "server.blob.mjs", ...BLOB_ENTRY_NAMES_DEFAULT] as const

function resolveBlobUserAppEntry(rootDir: string) {
  const names = process.env.VITEHUB_VITE_MODE === "blob" ? BLOB_ENTRY_NAMES_PRIORITIZED : BLOB_ENTRY_NAMES_DEFAULT
  return resolveUserAppEntry(rootDir, { names })
}

type BlobProvider = "cloudflare" | "vercel"

interface ProviderEntrySpec {
  entryFile: string
  factory: string
  hosting: string
  name: BlobProvider
  runtimeModule: string
}

const providerEntrySpecs: ProviderEntrySpec[] = [
  { entryFile: "cloudflare-worker.mjs", factory: "createBlobCloudflareWorker", hosting: "cloudflare", name: "cloudflare", runtimeModule: "runtime/cloudflare-vite" },
  { entryFile: "vercel-server.mjs", factory: "createBlobVercelServer", hosting: "vercel", name: "vercel", runtimeModule: "runtime/vercel-vite" },
]

interface GenerateProviderOutputsOptions {
  artifacts?: GeneratedBlobArtifacts
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined
  clientOutDir: string
  providerOutput?: ComposedProviderOutput
  rootDir: string
  serverFunctionName?: string
}

interface GeneratedBlobArtifacts {
  cloudflareWorkerFile: string
  generatedDir: string
  runtimeModuleFiles: Record<BlobProvider, string>
  vercelServerFile: string
}

interface CloudflareBlobConfig {
  assets?: { directory?: string, run_worker_first: string[] }
  compatibility_date: string
  compatibility_flags: string[]
  main: string
  name?: string
  observability: { enabled: true }
  r2_buckets?: Array<{ binding: string, bucket_name: string }>
}

const driverModules = {
  akamai: "drivers/akamai",
  azure: "drivers/azure",
  box: "drivers/box",
  "cloudflare-r2": "drivers/cloudflare",
  "digitalocean-spaces": "drivers/digitalocean-spaces",
  dropbox: "drivers/dropbox",
  fs: "drivers/fs",
  gcs: "drivers/gcs",
  "google-drive": "drivers/google-drive",
  hetzner: "drivers/hetzner",
  minio: "drivers/minio",
  "netlify-blobs": "drivers/netlify-blobs",
  onedrive: "drivers/onedrive",
  s3: "drivers/s3",
  storj: "drivers/storj",
  supabase: "drivers/supabase",
  uploadthing: "drivers/uploadthing",
  "vercel-blob": "drivers/vercel",
} satisfies Record<NonNullable<ResolvedBlobModuleOptions["store"]>["driver"], string>

function getRuntimeBlobStoreResolver(driver: string | undefined) {
  switch (driver) {
    case "minio":
      return "resolveRuntimeMinioBlobStore"
    case "vercel-blob":
      return "resolveRuntimeVercelBlobStore"
    default:
      return undefined
  }
}

function isCloudflareR2StoreWithBucket(store: ResolvedBlobModuleOptions["store"]): store is ResolvedCloudflareR2BlobStoreConfig & { bucketName: string } {
  return store.driver === "cloudflare-r2" && Boolean(store.bucketName)
}

function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined): Array<{ binding: string, bucket_name: string }> | undefined {
  if (!config) {
    return undefined
  }

  const bindingsByBinding = new Map<string, { binding: string, bucket_name: string }>()
  for (const store of Object.values(config.stores || { default: config.store })) {
    if (!isCloudflareR2StoreWithBucket(store) || bindingsByBinding.has(store.binding)) {
      continue
    }
    bindingsByBinding.set(store.binding, {
      binding: store.binding,
      bucket_name: store.bucketName,
    })
  }
  const bindings = [...bindingsByBinding.values()]

  return bindings.length > 0 ? bindings : undefined
}

function resolveBlobConfig(
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined,
  hosting: string,
): false | ResolvedBlobModuleOptions {
  return blob && typeof blob === "object" && "store" in blob
    ? blob
    : normalizeBlobOptions(blob, { hosting }) || false
}

function renderProviderEntry(
  spec: ProviderEntrySpec,
  entryFile: string,
  userAppEntry: string | undefined,
  blobConfig: false | ResolvedBlobModuleOptions,
) {
  const imports = [
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("runtime/state")))}`,
    `import { ${spec.factory} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(spec.runtimeModule)))}`,
  ]
  const driverModule = blobConfig ? driverModules[blobConfig.store.driver] : undefined
  if (driverModule) {
    imports.push(`import { createBlobStorage } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("storage")))}`)
    imports.push(`import { createDriver } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule(driverModule)))}`)
  }
  const runtimeStoreResolver = getRuntimeBlobStoreResolver(blobConfig ? blobConfig.store.driver : undefined)
  if (runtimeStoreResolver) {
    imports.push(`import { ${runtimeStoreResolver} } from ${JSON.stringify(createImportPath(entryFile, resolveRuntimeModule("config")))}`)
  }

  const storageExpression = !blobConfig
    ? undefined
    : runtimeStoreResolver
      ? `createBlobStorage(createDriver(${runtimeStoreResolver}(blobConfig.store, process.env)))`
      : "createBlobStorage(createDriver(blobConfig.store))"

  const lines = [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    storageExpression ? `setBlobRuntimeStorage(${storageExpression})` : "setBlobRuntimeStorage(undefined)",
    userAppEntry ? `const app = (await import(${JSON.stringify(createImportPath(entryFile, userAppEntry))})).default` : "const app = undefined",
    "",
    `export default ${spec.factory}({`,
    "  app,",
    "  blob: blobConfig,",
    "})",
    "",
  ]

  return lines.filter(Boolean).join("\n")
}

function renderBlobRuntimeModule(file: string, blobConfig: false | ResolvedBlobModuleOptions) {
  const stores = blobConfig ? Object.values(blobConfig.stores || { default: blobConfig.store }) : []
  const selectedDriverModules = [...new Set(stores.map(store => driverModules[store.driver]))]
  const driverImports = Object.fromEntries(selectedDriverModules.map((driverModule, index) => [driverModule, `createDriver${index}`]))
  const imports = [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("ensure")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
  ]
  if (selectedDriverModules.length > 0) {
    imports.push(`import { createBlobStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("storage")))}`)
  }
  for (const driverModule of selectedDriverModules) {
    const driverImport = driverImports[driverModule]
    imports.push(`import { createDriver as ${driverImport} } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(driverModule)))}`)
  }
  const runtimeStoreResolvers = [...new Set(stores.map(store => getRuntimeBlobStoreResolver(store.driver)).filter(Boolean))]
  if (runtimeStoreResolvers.length > 0) {
    imports.push(`import { ${runtimeStoreResolvers.join(", ")} } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("config")))}`)
  }

  const createDriverCases = Object.entries(driverModules).map(([driver, driverModule]) => {
      const driverImport = driverImports[driverModule]
      if (!driverImport) return undefined
      const runtimeStoreResolver = getRuntimeBlobStoreResolver(driver)
      const storeExpression = runtimeStoreResolver ? `${runtimeStoreResolver}(store, process.env)` : "store"
      return `    case ${JSON.stringify(driver)}: return ${driverImport}(${storeExpression})`
    }).filter(Boolean)

  return [
    ...imports,
    "",
    `const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    ...(blobConfig
      ? [
          "function joinServedBlobUrl(...parts) {",
          "  const [first, ...rest] = parts.filter(Boolean)",
          "  if (!first) return \"\"",
          "  const base = first.replace(/\\/+$/, \"\")",
          "  const path = rest.map(part => part.replace(/^\\/+|\\/+$/g, \"\")).filter(Boolean).join(\"/\")",
          "  if (!base) return path ? `/\${path}` : \"/\"",
          "  return path ? `\${base}/\${path}` : base",
          "}",
          "",
          "function withServedBlobUrl(name, object) {",
          "  const serve = blobConfig?.serve",
          "  if (!serve || serve.store !== name) return object",
          "  return { ...object, url: joinServedBlobUrl(serve.publicBaseUrl || \"/\", serve.route, object.pathname) }",
          "}",
          "",
          "const blobStorages = new Map()",
          "",
          "function createBlobDriver(store) {",
          "  switch (store.driver) {",
          ...createDriverCases,
          "  }",
          "}",
          "",
          "function resolveBlobStoreConfig(name) {",
          "  const stores = blobConfig.stores || { default: blobConfig.store }",
          "  const store = stores[name]",
          "  if (!store) throw new Error(`Unknown Blob store \"${name}\".`)",
          "  return store",
          "}",
          "",
          "function createGeneratedBlobStorage(name = \"default\") {",
          "  const existing = blobStorages.get(name)",
          "  if (existing) return existing",
          "  const storage = createBlobStorage(createBlobDriver(resolveBlobStoreConfig(name)))",
          "  const runtimeStorage = {",
          "    ...storage,",
          "    async head(pathname) { return withServedBlobUrl(name, await storage.head(pathname)) },",
          "    async list(options) {",
          "      const result = await storage.list(options)",
          "      return { ...result, blobs: result.blobs.map(object => withServedBlobUrl(name, object)) }",
          "    },",
          "    async put(pathname, body, options) { return withServedBlobUrl(name, await storage.put(pathname, body, options)) },",
          "    store: storeName => createGeneratedBlobStorage(storeName),",
          "  }",
          "  blobStorages.set(name, runtimeStorage)",
          "  return runtimeStorage",
          "}",
          "",
          "export const blob = createGeneratedBlobStorage()",
          "setBlobRuntimeStorage(blob)",
        ]
      : [
          "export const blob = undefined",
          "setBlobRuntimeStorage(undefined)",
        ]),
    "export { ensureBlob }",
    "",
  ].join("\n")
}

async function writeProviderEntries(rootDir: string, blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  const generatedDir = ensureGeneratedDir(rootDir, productName)
  await mkdir(generatedDir, { recursive: true })

  const userAppEntry = resolveBlobUserAppEntry(rootDir)
  const entryFiles: Record<BlobProvider, string> = { cloudflare: "", vercel: "" }
  const runtimeModuleFiles: Record<BlobProvider, string> = { cloudflare: "", vercel: "" }

  for (const spec of providerEntrySpecs) {
    const entryFile = resolve(generatedDir, spec.entryFile)
    const runtimeModuleFile = resolve(generatedDir, `${spec.name}-runtime.mjs`)
    const blobConfig = resolveBlobConfig(blob, spec.hosting)
    await writeFile(entryFile, renderProviderEntry(spec, entryFile, userAppEntry, blobConfig), "utf8")
    await writeFile(runtimeModuleFile, renderBlobRuntimeModule(runtimeModuleFile, blobConfig), "utf8")
    entryFiles[spec.name] = entryFile
    runtimeModuleFiles[spec.name] = runtimeModuleFile
  }

  return {
    cloudflareWorkerFile: entryFiles.cloudflare,
    generatedDir,
    runtimeModuleFiles,
    vercelServerFile: entryFiles.vercel,
  } satisfies GeneratedBlobArtifacts
}

function createCloudflareOutput(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined, artifacts: GeneratedBlobArtifacts, providerOutput: ComposedProviderOutput | undefined): CloudflareProviderDeploymentOutput {
  const resolved = resolveBlobConfig(blob, "cloudflare")
  const databaseRuntime = getProviderRuntimeModule(providerOutput, "database", "cloudflare")

  const wranglerConfig: CloudflareBlobConfig = {
    compatibility_date: defaultCloudflareCompatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    main: "index.js",
    observability: { enabled: true },
    ...(createCloudflareR2Bindings(resolved) ? { r2_buckets: createCloudflareR2Bindings(resolved) } : {}),
  }

  return {
    bundleEntry: artifacts.cloudflareWorkerFile,
    bundleOptions: {
      alias: {
        "@vite-hub/blob": artifacts.runtimeModuleFiles.cloudflare,
        ...(databaseRuntime ? { "@vite-hub/database/drizzle": databaseRuntime } : {}),
      },
      conditions: ["workerd", "worker", "browser", "default"],
      external: [
        "@aws-sdk/client-s3",
        "@aws-sdk/s3-presigned-post",
        "@aws-sdk/s3-request-presigner",
        "files-sdk",
        "files-sdk/r2",
        "node:async_hooks",
        "#vitehub/blob/config",
      ],
      format: "esm",
      platform: "neutral",
    },
    wranglerConfigKeys: ["r2_buckets"],
    wranglerConfig,
  }
}

function createVercelOutput(
  artifacts: GeneratedBlobArtifacts,
  providerOutput: ComposedProviderOutput | undefined,
  serverFunctionName?: string,
): VercelProviderDeploymentOutput {
  const databaseRuntime = getProviderRuntimeModule(providerOutput, "database", "vercel")

  return {
    bundleEntry: artifacts.vercelServerFile,
    bundleOptions: {
      alias: {
        "@vite-hub/blob": artifacts.runtimeModuleFiles.vercel,
        ...(databaseRuntime ? { "@vite-hub/database/drizzle": databaseRuntime } : {}),
      },
      external: [
        "files-sdk",
        "files-sdk/akamai",
        "files-sdk/azure",
        "files-sdk/box",
        "files-sdk/digitalocean-spaces",
        "files-sdk/dropbox",
        "files-sdk/fs",
        "files-sdk/gcs",
        "files-sdk/google-drive",
        "files-sdk/hetzner",
        "files-sdk/minio",
        "files-sdk/netlify-blobs",
        "files-sdk/onedrive",
        "files-sdk/r2",
        "files-sdk/s3",
        "files-sdk/storj",
        "files-sdk/supabase",
        "files-sdk/uploadthing",
        "files-sdk/vercel-blob",
        "#vitehub/blob/config",
      ],
      format: "esm",
      platform: "node",
    },
    ...(serverFunctionName ? { function: { kind: "isolated" as const, name: serverFunctionName } } : {}),
  }
}

function hasExplicitFsStore(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  if (!blob || typeof blob !== "object") return false
  if ("stores" in blob && blob.stores) return Object.values(blob.stores).some(store => store.driver === "fs")
  if ("store" in blob) return blob.store.driver === "fs"
  return "driver" in blob && blob.driver === "fs"
}

function shouldCreateProviderOutput(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  return !hasExplicitFsStore(blob)
}

function registerSupportedProviderRuntimeModules(
  providerOutput: ComposedProviderOutput | undefined,
  artifacts: GeneratedBlobArtifacts,
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined,
): void {
  registerProviderRuntimeModules(providerOutput, productName, shouldCreateProviderOutput(blob) ? artifacts.runtimeModuleFiles : {})
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedBlobArtifacts> {
  const artifacts = options.artifacts ?? await prepareProviderOutputs(options)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.blob)
  const localOnly = !shouldCreateProviderOutput(options.blob)
  await writeProviderDeploymentOutputs({
    clientOutDir: options.clientOutDir,
    cloudflare: localOnly ? undefined : createCloudflareOutput(options.blob, artifacts, options.providerOutput),
    rootDir: options.rootDir,
    vercel: localOnly ? undefined : createVercelOutput(artifacts, options.providerOutput, options.serverFunctionName),
  })
  return artifacts
}

export async function prepareProviderOutputs(options: Pick<GenerateProviderOutputsOptions, "blob" | "providerOutput" | "rootDir">): Promise<GeneratedBlobArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.blob)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.blob)
  return artifacts
}
