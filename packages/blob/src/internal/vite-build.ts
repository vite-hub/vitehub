import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "pathe"

import { defaultCloudflareCompatibilityDate } from "@vite-hub/internal/build/cloudflare"
import { createDefaultCloudflareOutputRoot, getProviderRuntimeModule, registerProviderRuntimeModules, registerVercelRuntimePackages, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { computePackageDir, createImportPath, ensureGeneratedDir, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"
import { resolveUserAppEntry } from "@vite-hub/internal/build/user-entry"
import { copyVercelFunctionRuntimePackages } from "@vite-hub/internal/build/vercel-runtime-packages"
import { isPlainObject } from "@vite-hub/internal/object"

import { normalizeBlobOptions } from "../config.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import type { CloudflareProviderDeploymentOutput, ComposedProviderOutput, VercelProviderDeploymentOutput } from "@vite-hub/internal/build/deployment-output"
import type { VercelFunctionRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"

export const blobPackageName = "@vite-hub/blob"
const cloudflareBlobWorkerMarker = "vitehub-blob-worker"
const cloudflareBlobOutputState = ".vitehub/blob/cloudflare-output.json"
const vercelBlobOutputMarker = ".vitehub-blob-output"
const productName = "blob"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)
const filesSdkS3Peers = ["@aws-sdk/client-s3", "@aws-sdk/lib-storage", "@aws-sdk/s3-presigned-post", "@aws-sdk/s3-request-presigner"]
const filesSdkDriverPeers: Record<string, string[]> = {
  akamai: filesSdkS3Peers,
  azure: ["@azure/storage-blob"],
  box: ["box-typescript-sdk-gen"],
  "cloudflare-r2": filesSdkS3Peers,
  "digitalocean-spaces": filesSdkS3Peers,
  dropbox: ["dropbox"],
  gcs: ["@google-cloud/storage"],
  "google-drive": ["@googleapis/drive", "google-auth-library"],
  hetzner: filesSdkS3Peers,
  minio: filesSdkS3Peers,
  "netlify-blobs": ["@netlify/blobs"],
  onedrive: ["@azure/identity", "@microsoft/microsoft-graph-client"],
  s3: filesSdkS3Peers,
  storj: filesSdkS3Peers,
  supabase: ["@supabase/storage-js"],
  uploadthing: ["uploadthing"],
}

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
  cloudflareOwnedByNitro?: boolean
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

function getDriverModule(driver: NonNullable<ResolvedBlobModuleOptions["store"]>["driver"], provider?: BlobProvider, nativeCloudflareR2 = false) {
  if (driver === "cloudflare-r2" && provider === "cloudflare" && nativeCloudflareR2) return "drivers/cloudflare-native"
  if (driver === "vercel-blob" && provider === "vercel") return "drivers/vercel-bundled"
  return driverModules[driver]
}

function isResolvedBlobStore(store: unknown): store is ResolvedBlobModuleOptions["store"] {
  if (!isPlainObject(store) || typeof store.driver !== "string" || !Object.hasOwn(driverModules, store.driver)) return false
  switch (store.driver) {
    case "cloudflare-r2":
      return typeof store.binding === "string"
    case "fs":
      return typeof store.base === "string"
    case "minio":
      return typeof store.bucket === "string"
        && typeof store.endpoint === "string"
        && typeof store.forcePathStyle === "boolean"
        && typeof store.region === "string"
    case "vercel-blob":
      return (store.access === "private" || store.access === "public") && typeof store.token === "string"
    default:
      return true
  }
}

function isResolvedBlobConfig(blob: object): blob is ResolvedBlobModuleOptions {
  if (!("store" in blob) || !isResolvedBlobStore(blob.store)) return false
  if (!("stores" in blob) || typeof blob.stores === "undefined") return true
  return isPlainObject(blob.stores) && Object.values(blob.stores).every(isResolvedBlobStore)
}

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

export function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined): Array<{ binding: string, bucket_name: string }> | undefined {
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
  if (blob && typeof blob === "object" && "store" in blob) {
    if (!isResolvedBlobConfig(blob)) {
      throw new TypeError("`blob.store` must contain a fully resolved Blob store with a supported `driver`.")
    }
    return blob
  }
  return normalizeBlobOptions(blob, { hosting }) || false
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
  const nativeCloudflareR2 = Boolean(blobConfig && isCloudflareR2StoreWithBucket(blobConfig.store))
  const driverModule = blobConfig ? getDriverModule(blobConfig.store.driver, spec.name, nativeCloudflareR2) : undefined
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

export function renderBlobRuntimeModule(file: string, blobConfig: false | ResolvedBlobModuleOptions, provider?: BlobProvider) {
  const stores = blobConfig ? Object.values(blobConfig.stores || { default: blobConfig.store }) : []
  const nativeCloudflareR2 = stores
    .filter(store => store.driver === "cloudflare-r2")
    .every(isCloudflareR2StoreWithBucket)
  const selectedDriverModules = [...new Set(stores.map(store => getDriverModule(store.driver, provider, nativeCloudflareR2)))]
  const driverImports = Object.fromEntries(selectedDriverModules.map((driverModule, index) => [driverModule, `createDriver${index}`]))
  const imports = [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("ensure")))}`,
    `import { setBlobRuntimeConfig, setBlobRuntimeStorage, setNamedBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
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

  const createDriverCases = Object.keys(driverModules).map((driver) => {
    const driverModule = getDriverModule(driver as keyof typeof driverModules, provider, nativeCloudflareR2)
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
          "function createLazyGeneratedBlobStorage(name) {",
          "  return {",
          "    async del(pathnames) { return createGeneratedBlobStorage(name).del(pathnames) },",
          "    async get(pathname) { return createGeneratedBlobStorage(name).get(pathname) },",
          "    async head(pathname) { return createGeneratedBlobStorage(name).head(pathname) },",
          "    async list(options) { return createGeneratedBlobStorage(name).list(options) },",
          "    async put(pathname, body, options) { return createGeneratedBlobStorage(name).put(pathname, body, options) },",
          "    async sign(pathname, options) { return createGeneratedBlobStorage(name).sign(pathname, options) },",
          "    async serve(event, pathname) { return createGeneratedBlobStorage(name).serve(event, pathname) },",
          "    store: storeName => createLazyGeneratedBlobStorage(storeName),",
          "  }",
          "}",
          "",
          "export const blob = createLazyGeneratedBlobStorage(\"default\")",
          "setBlobRuntimeStorage(blob)",
          "for (const name of Object.keys(blobConfig.stores || { default: blobConfig.store })) {",
          "  if (name !== \"default\") setNamedBlobRuntimeStorage(name, createLazyGeneratedBlobStorage(name))",
          "}",
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
    await writeFile(runtimeModuleFile, renderBlobRuntimeModule(runtimeModuleFile, blobConfig, spec.name), "utf8")
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
        "@vite-hub/blob/content-type": resolveRuntimeModule("content-type"),
        "@vite-hub/blob": artifacts.runtimeModuleFiles.cloudflare,
        ...(databaseRuntime ? { "@vite-hub/database/drizzle": databaseRuntime } : {}),
      },
      banner: `// ${cloudflareBlobWorkerMarker}`,
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

function isLegacyCloudflareBlobWorker(worker: string, wrangler: unknown): boolean {
  if (!wrangler || typeof wrangler !== "object" || Array.isArray(wrangler)) return false
  const config = wrangler as Record<string, unknown>
  const compatibilityFlags = Array.isArray(config.compatibility_flags) ? config.compatibility_flags : []
  const observability = config.observability && typeof config.observability === "object" && !Array.isArray(config.observability)
    ? config.observability as Record<string, unknown>
    : {}
  return worker.includes("function createBlobCloudflareWorker(")
    && worker.includes("setBlobRuntimeConfig(")
    && config.main === "index.js"
    && compatibilityFlags.includes("nodejs_compat")
    && observability.enabled === true
}

async function createNitroCloudflareCleanup(rootDir: string, hasCurrentContribution: boolean) {
  const outputRoot = createDefaultCloudflareOutputRoot(rootDir)
  let ownsWorker = false
  let ownsR2Buckets = false
  try {
    const worker = await readFile(resolve(outputRoot, "index.js"), "utf8")
    ownsWorker = worker.includes(cloudflareBlobWorkerMarker)
    if (!ownsWorker) {
      try {
        ownsWorker = isLegacyCloudflareBlobWorker(worker, JSON.parse(await readFile(resolve(outputRoot, "wrangler.json"), "utf8")))
      }
      catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  try {
    const [state, wrangler] = await Promise.all([
      readFile(resolve(rootDir, cloudflareBlobOutputState), "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
      readFile(resolve(outputRoot, "wrangler.json"), "utf8").then(value => JSON.parse(value) as Record<string, unknown>),
    ])
    ownsR2Buckets = JSON.stringify(state.r2_buckets) === JSON.stringify(wrangler.r2_buckets)
    await rm(resolve(rootDir, cloudflareBlobOutputState), { force: true })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return {
    fileNames: ownsWorker ? ["index.js"] : [],
    outputRoot,
    wranglerConfigOwnership: {
      keys: [
        ...(ownsWorker ? ["compatibility_date", "compatibility_flags", "main", "observability"] : []),
        ...(ownsWorker || (ownsR2Buckets && !hasCurrentContribution) ? ["r2_buckets"] : []),
      ],
    },
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
        "@vite-hub/blob/content-type": resolveRuntimeModule("content-type"),
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

function hasFilesSdkStore(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined) {
  const resolved = resolveBlobConfig(blob, "vercel")
  return resolved !== false && Object.values(resolved.stores || { default: resolved.store })
    .some(store => store.driver !== "fs" && store.driver !== "vercel-blob")
}

function hasSiblingVercelRuntime(providerOutput: ComposedProviderOutput | undefined): boolean {
  return Object.entries(providerOutput?.runtimeModuleFilesByProduct || {})
    .some(([product, modules]) => product !== productName && Boolean(modules?.vercel))
}

async function copyVercelBlobRuntimePackages(options: GenerateProviderOutputsOptions) {
  const packages = getVercelBlobRuntimePackages(options.blob)
  const isolated = Boolean(options.serverFunctionName && options.serverFunctionName !== "__server.func")
  const shared = !isolated && hasSiblingVercelRuntime(options.providerOutput)
  const outputName = options.serverFunctionName ?? "__server.func"
  if (packages.length) {
    if (shared) await mkdir(resolve(options.rootDir, ".vercel/output/functions", outputName), { recursive: true })
    await copyVercelFunctionRuntimePackages({
      packages,
      rootDir: options.rootDir,
      serverFunctionName: options.serverFunctionName,
    })
  }
  if (!shared) {
    const entry = await readFile(resolve(options.rootDir, ".vercel/output/functions", outputName, "index.mjs"))
    await writeFile(resolve(options.rootDir, ".vercel/output/functions", outputName, vercelBlobOutputMarker), createHash("sha256").update(entry).digest("hex"), "utf8")
  }
}

function getVercelBlobRuntimePackages(blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined): VercelFunctionRuntimePackage[] {
  const packages = new Set<string>()
  const filesSdkPeers = new Set<string>()
  const resolved = resolveBlobConfig(blob, "vercel")
  const stores = resolved === false ? [] : Object.values(resolved.stores || { default: resolved.store })
  if (stores.some(store => store.driver === "vercel-blob")) packages.add("@vercel/blob")
  if (hasFilesSdkStore(blob)) packages.add("files-sdk")
  for (const store of stores) {
    for (const name of filesSdkDriverPeers[store.driver] ?? []) {
      packages.add(name)
      filesSdkPeers.add(name)
    }
  }
  return [...packages].map(name => ({
    name,
    optional: filesSdkPeers.has(name),
    resolveFrom: resolve(packageDir, filesSdkPeers.has(name) ? "node_modules/files-sdk/package.json" : "package.json"),
  }))
}

function getVercelBlobOutputCleanup(options: GenerateProviderOutputsOptions) {
  return async () => {
    const cleanup: Array<{ serverFunctionName: string }> = []
    for (const name of new Set([options.serverFunctionName, "__blob.func"].filter((name): name is string => Boolean(name && name !== "__server.func")))) {
      try {
        const outputRoot = resolve(options.rootDir, ".vercel/output/functions", name)
        const [entry, marker] = await Promise.all([
          readFile(resolve(outputRoot, "index.mjs")),
          readFile(resolve(outputRoot, vercelBlobOutputMarker), "utf8"),
        ])
        if (createHash("sha256").update(entry).digest("hex") === marker) cleanup.push({ serverFunctionName: name })
      }
      catch {}
    }
    return cleanup
  }
}

function registerSupportedProviderRuntimeModules(
  providerOutput: ComposedProviderOutput | undefined,
  artifacts: GeneratedBlobArtifacts,
  blob: BlobModuleOptions | ResolvedBlobModuleOptions | undefined,
): void {
  registerProviderRuntimeModules(providerOutput, productName, shouldCreateProviderOutput(blob) ? artifacts.runtimeModuleFiles : {})
  registerVercelRuntimePackages(providerOutput, productName, shouldCreateProviderOutput(blob) ? getVercelBlobRuntimePackages(blob) : [])
}

export async function generateProviderOutputs(options: GenerateProviderOutputsOptions): Promise<GeneratedBlobArtifacts> {
  const artifacts = options.artifacts ?? await prepareProviderOutputs(options)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.blob)
  const localOnly = !shouldCreateProviderOutput(options.blob)
  const createCloudflare = !localOnly && !options.cloudflareOwnedByNitro
  const createVercel = !localOnly && !options.cloudflareOwnedByNitro
  const stageSharedVercelRuntime = (!options.serverFunctionName || options.serverFunctionName === "__server.func")
    && hasSiblingVercelRuntime(options.providerOutput)
  const cleanupVercel = options.cloudflareOwnedByNitro ? getVercelBlobOutputCleanup(options) : undefined
  const hasCurrentCloudflareContribution = Boolean(createCloudflareR2Bindings(resolveBlobConfig(options.blob, "cloudflare"))?.length)
  if (options.cloudflareOwnedByNitro) {
    await writeProviderDeploymentOutputs({
      clientOutDir: options.clientOutDir,
      cleanup: { cloudflare: () => createNitroCloudflareCleanup(options.rootDir, hasCurrentCloudflareContribution) },
      rootDir: options.rootDir,
    })
  }
  if (cleanupVercel) {
    await writeProviderDeploymentOutputs({
      clientOutDir: options.clientOutDir,
      cleanup: { vercel: cleanupVercel },
      rootDir: options.rootDir,
    })
  }
  await writeProviderDeploymentOutputs({
    afterWrite: createVercel || stageSharedVercelRuntime
      ? () => copyVercelBlobRuntimePackages(options)
      : undefined,
    clientOutDir: options.clientOutDir,
    cloudflare: createCloudflare ? createCloudflareOutput(options.blob, artifacts, options.providerOutput) : undefined,
    rootDir: options.rootDir,
    vercel: createVercel ? createVercelOutput(artifacts, options.providerOutput, options.serverFunctionName) : undefined,
  })
  if (createCloudflare) {
    const r2Buckets = createCloudflareR2Bindings(resolveBlobConfig(options.blob, "cloudflare"))
    await mkdir(dirname(resolve(options.rootDir, cloudflareBlobOutputState)), { recursive: true })
    await writeFile(resolve(options.rootDir, cloudflareBlobOutputState), `${JSON.stringify({ r2_buckets: r2Buckets }, null, 2)}\n`, "utf8")
  }
  else {
    await rm(resolve(options.rootDir, cloudflareBlobOutputState), { force: true })
  }
  return artifacts
}

export async function prepareProviderOutputs(options: Pick<GenerateProviderOutputsOptions, "blob" | "providerOutput" | "rootDir">): Promise<GeneratedBlobArtifacts> {
  const artifacts = await writeProviderEntries(options.rootDir, options.blob)
  registerSupportedProviderRuntimeModules(options.providerOutput, artifacts, options.blob)
  return artifacts
}
