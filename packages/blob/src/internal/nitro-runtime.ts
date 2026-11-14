import { resolve } from "pathe"

import { computePackageDir, createImportPath, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"

import { filesSdkDriverPeers } from "./files-sdk-peers.ts"

import type { CloudflareR2Jurisdiction, ResolvedBlobModuleOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import type { VercelFunctionRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"

export const blobPackageName = "@vite-hub/blob"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

type BlobProvider = "cloudflare" | "vercel"

const driverModules = {
  azure: "drivers/azure",
  "cloudflare-r2": "drivers/cloudflare",
  fs: "drivers/fs",
  gcs: "drivers/gcs",
  minio: "drivers/minio",
  "netlify-blobs": "drivers/netlify-blobs",
  s3: "drivers/s3",
  "vercel-blob": "drivers/vercel-bundled",
} satisfies Record<NonNullable<ResolvedBlobModuleOptions["store"]>["driver"], string>

function getDriverModule(driver: NonNullable<ResolvedBlobModuleOptions["store"]>["driver"], provider?: BlobProvider, nativeCloudflareR2 = false) {
  if (driver === "cloudflare-r2" && provider === "cloudflare" && nativeCloudflareR2) return "drivers/cloudflare-native"
  return driverModules[driver]
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

// A type alias, not an interface, so it fits the provider output's index-signature entry type.
type CloudflareR2Binding = {
  binding: string
  bucket_name: string
  jurisdiction?: CloudflareR2Jurisdiction
}

/** The Worker `images` binding. ViteHub adds it only for an explicit `cloudflare-images` transformer, because Cloudflare bills transformations. */
export function cloudflareImagesBinding(config: false | ResolvedBlobModuleOptions | undefined): { binding: string } | undefined {
  if (!config || !config.images || config.images.transformer !== "cloudflare-images") return undefined
  return { binding: config.images.binding ?? "IMAGES" }
}

export function createCloudflareR2Bindings(config: false | ResolvedBlobModuleOptions | undefined): CloudflareR2Binding[] | undefined {
  if (!config) {
    return undefined
  }

  const bindingsByBinding = new Map<string, CloudflareR2Binding>()
  for (const store of Object.values(config.stores || { default: config.store })) {
    if (!isCloudflareR2StoreWithBucket(store) || bindingsByBinding.has(store.binding)) {
      continue
    }
    bindingsByBinding.set(store.binding, {
      binding: store.binding,
      bucket_name: store.bucketName,
      ...(store.jurisdiction ? { jurisdiction: store.jurisdiction } : {}),
    })
  }
  const bindings = [...bindingsByBinding.values()]

  return bindings.length > 0 ? bindings : undefined
}

export function renderBlobRuntimeModule(file: string, blobConfig: false | ResolvedBlobModuleOptions, provider?: BlobProvider) {
  const stores = blobConfig ? Object.values(blobConfig.stores || { default: blobConfig.store }) : []
  // A store with `secretEnv` has env variable names in place of its credentials. They are read when the driver starts.
  const secrets = stores.some(store => store.secretEnv)
  const nativeCloudflareR2 = stores
    .filter(store => store.driver === "cloudflare-r2")
    .every(store => isCloudflareR2StoreWithBucket(store) && !store.remote)
  // Only `vite dev` sets `localFallback`: the R2 store then uses this `fs` store when the dev runner has no R2 binding.
  const localFallback = stores.some(store => store.driver === "cloudflare-r2" && store.localFallback)
  const selectedDriverModules = [...new Set([
    ...stores.map(store => getDriverModule(store.driver, provider, nativeCloudflareR2)),
    ...(localFallback ? [driverModules.fs] : []),
  ])]
  const driverImports = Object.fromEntries(selectedDriverModules.map((driverModule, index) => [driverModule, `createDriver${index}`]))
  const imports = [
    `import { ensureBlob } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("index")))}`,
    `import { ${secrets ? "blobRuntimeEnv, " : ""}setBlobRuntimeConfig, setBlobRuntimeStorage, setNamedBlobRuntimeStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("runtime/state")))}`,
  ]
  if (selectedDriverModules.length > 0) {
    imports.push(`import { createBlobStorage, createLazyBlobMedia, handleBlobMultipartUpload, handleBlobUpload, blobStoreMode, readonlyBlobStorage } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("storage")))}`)
    imports.push(`import { blobResult, unknownBlobStoreError } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("errors")))}`)
  }
  for (const driverModule of selectedDriverModules) {
    const driverImport = driverImports[driverModule]
    imports.push(`import { createDriver as ${driverImport} } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule(driverModule)))}`)
  }
  if (localFallback) {
    imports.push(`import { getOptionalBucket } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("drivers/cloudflare-native")))}`)
  }
  const runtimeStoreResolvers = [...new Set([
    ...stores.map(store => getRuntimeBlobStoreResolver(store.driver)).filter(Boolean),
    ...(secrets ? ["resolveRuntimeBlobSecrets"] : []),
  ])]
  if (runtimeStoreResolvers.length > 0) {
    imports.push(`import { ${runtimeStoreResolvers.join(", ")} } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("config")))}`)
  }

  const createDriverCases = Object.keys(driverModules).map((driver) => {
    const driverModule = getDriverModule(driver as keyof typeof driverModules, provider, nativeCloudflareR2)
    const driverImport = driverImports[driverModule]
    if (!driverImport) return undefined
    const runtimeStoreResolver = getRuntimeBlobStoreResolver(driver)
    const store = secrets ? "resolveRuntimeBlobSecrets(store, blobRuntimeEnv())" : "store"
    const storeExpression = runtimeStoreResolver ? `${runtimeStoreResolver}(${store}, process.env)` : store
    if (driver === "cloudflare-r2" && localFallback) {
      return `    case ${JSON.stringify(driver)}: return store.localFallback && !getOptionalBucket(store) ? ${driverImports[driverModules.fs]}(store.localFallback) : ${driverImport}(${storeExpression})`
    }
    return `    case ${JSON.stringify(driver)}: return ${driverImport}(${storeExpression})`
  }).filter(Boolean)

  return [
    ...imports,
    "",
    `export const blobConfig = ${JSON.stringify(blobConfig, null, 2)}`,
    "setBlobRuntimeConfig(blobConfig)",
    ...(blobConfig
      ? [
          "function joinServedBlobUrl(...parts) {",
          "  const [first, ...rest] = parts.filter(Boolean)",
          "  if (!first) return \"\"",
          "  const base = first.replace(/\\/+$/, \"\")",
          "  const path = rest.map(part => part.replace(/^\\/+|\\/+$/g, \"\")).filter(Boolean).join(\"/\")",
          "  if (!base) return path ? `/${path}` : \"/\"",
          "  return path ? `${base}/${path}` : base",
          "}",
          "function encodeServedBlobPath(pathname) {",
          "  return pathname.split('/').map(segment => encodeURIComponent(segment)).join('/')",
          "}",
          "",
          "function servedBlobUrl(name, pathname) {",
          "  const serve = blobConfig?.serve",
          "  if (!serve || serve.store !== name) return undefined",
          "  return joinServedBlobUrl(serve.publicBaseUrl || \"/\", serve.route, encodeServedBlobPath(pathname))",
          "}",
          "",
          "function withServedBlobUrl(name, object) {",
          "  const url = servedBlobUrl(name, object.pathname)",
          "  return url ? { ...object, url } : object",
          "}",
          "",
          "function withServedMultipartUrl(name, upload) {",
          "  return {",
          "    ...upload,",
          "    async complete(parts) {",
          "      const [error, object] = await upload.complete(parts)",
          "      return error ? [error, undefined] : [undefined, withServedBlobUrl(name, object)]",
          "    },",
          "  }",
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
          "  if (!Object.prototype.hasOwnProperty.call(stores, name)) throw unknownBlobStoreError(name, stores)",
          "  const store = stores[name]",
          "  if (!store) throw unknownBlobStoreError(name, stores)",
          "  return store",
          "}",
          "",
          "function selectGeneratedBlobStore(name, options, createStorage) {",
          "  const mode = blobStoreMode(options)",
          "  const storage = createStorage(name)",
          "  return mode === \"read\" ? readonlyBlobStorage(storage) : storage",
          "}",
          "",
          "function createGeneratedBlobStorage(name = \"default\") {",
          "  const existing = blobStorages.get(name)",
          "  if (existing) return existing",
          "  const storage = createBlobStorage(createBlobDriver(resolveBlobStoreConfig(name)), name, { images: blobConfig.images, url: pathname => servedBlobUrl(name, pathname) })",
          "  const runtimeStorage = {",
          "    ...storage,",
          "    async copy(from, to, options) {",
          "      const [error, object] = await storage.copy(from, to, options)",
          "      return error ? [error, undefined] : [undefined, withServedBlobUrl(name, object)]",
          "    },",
          "    async createMultipartUpload(pathname, options) {",
          "      const [error, upload] = await storage.createMultipartUpload(pathname, options)",
          "      return error ? [error, undefined] : [undefined, withServedMultipartUrl(name, upload)]",
          "    },",
          "    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(runtimeStorage, event, options),",
          "    handleUpload: (event, options) => handleBlobUpload(runtimeStorage, event, options),",
          "    async resumeMultipartUpload(pathname, uploadId) {",
          "      const [error, upload] = await storage.resumeMultipartUpload(pathname, uploadId)",
          "      return error ? [error, undefined] : [undefined, withServedMultipartUrl(name, upload)]",
          "    },",
          "    async head(pathname) {",
          "      const [error, object] = await storage.head(pathname)",
          "      return error ? [error, undefined] : [undefined, object && withServedBlobUrl(name, object)]",
          "    },",
          "    async list(options) {",
          "      const [error, result] = await storage.list(options)",
          "      return error ? [error, undefined] : [undefined, { ...result, blobs: result.blobs.map(object => withServedBlobUrl(name, object)) }]",
          "    },",
          "    async put(pathname, body, options) {",
          "      const [error, object] = await storage.put(pathname, body, options)",
          "      return error ? [error, undefined] : [undefined, withServedBlobUrl(name, object)]",
          "    },",
          "    store: (storeName, options) => selectGeneratedBlobStore(storeName, options, createGeneratedBlobStorage),",
          "  }",
          "  blobStorages.set(name, runtimeStorage)",
          "  return runtimeStorage",
          "}",
          "",
          "async function resolveGeneratedBlobStorage(name, operation) {",
          "  resolveBlobStoreConfig(name)",
          "  return blobResult(operation, name, async () => createGeneratedBlobStorage(name))",
          "}",
          "",
          "function createLazyGeneratedBlobStorage(name) {",
          "  return {",
          "    media: createLazyBlobMedia(() => resolveGeneratedBlobStorage(name, \"media\")),",
          "    async copy(from, to, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"copy\"); return error ? [error, undefined] : storage.copy(from, to, options) },",
          "    async createMultipartUpload(pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.createMultipartUpload(pathname, options) },",
          "    async handleMultipartUpload(event, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.handleMultipartUpload(event, options) },",
          "    async handleUpload(event, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"upload\"); return error ? [error, undefined] : storage.handleUpload(event, options) },",
          "    async resumeMultipartUpload(pathname, uploadId) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.resumeMultipartUpload(pathname, uploadId) },",
          "    async delete(pathnames) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"delete\"); return error ? [error, undefined] : storage.delete(pathnames) },",
          "    async get(pathname) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"get\"); return error ? [error, undefined] : storage.get(pathname) },",
          "    async head(pathname) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"head\"); return error ? [error, undefined] : storage.head(pathname) },",
          "    async list(options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"list\"); return error ? [error, undefined] : storage.list(options) },",
          "    async put(pathname, body, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"put\"); return error ? [error, undefined] : storage.put(pathname, body, options) },",
          "    async sign(pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"sign\"); return error ? [error, undefined] : storage.sign(pathname, options) },",
          "    async serve(request, pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"serve\"); if (error) throw error; return storage.serve(request, pathname, options) },",
          "    store: (storeName, options) => selectGeneratedBlobStore(storeName, options, createLazyGeneratedBlobStorage),",
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

/**
 * Lists the packages that a sibling Vercel function needs to run this Blob runtime module.
 * Queue, Database, and Workflow still bundle their own host functions and copy these packages into them.
 */
export function getBlobVercelRuntimePackages(blobConfig: ResolvedBlobModuleOptions): VercelFunctionRuntimePackage[] {
  const filesSdkPeers = new Set(Object.values(blobConfig.stores || { default: blobConfig.store }).flatMap(store => filesSdkDriverPeers[store.driver] ?? []))
  return [blobPackageName, ...filesSdkPeers].map(name => ({
    name,
    resolveFrom: resolve(packageDir, filesSdkPeers.has(name) ? "node_modules/files-sdk/package.json" : "package.json"),
  }))
}
