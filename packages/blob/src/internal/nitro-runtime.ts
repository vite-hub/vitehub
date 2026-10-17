import { resolve } from "pathe"

import { computePackageDir, createImportPath, resolveRuntimeModule as resolveRuntimeFromPkg } from "@vite-hub/internal/build/paths"

import { filesSdkDriverPeers } from "./files-sdk-peers.ts"

import type { ResolvedBlobModuleOptions, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import type { VercelFunctionRuntimePackage } from "@vite-hub/internal/build/vercel-runtime-packages"

export const blobPackageName = "@vite-hub/blob"
const packageDir = computePackageDir(import.meta.url)
const resolveRuntimeModule = (modulePath: string) => resolveRuntimeFromPkg(packageDir, modulePath)

type BlobProvider = "cloudflare" | "vercel"

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
    imports.push(`import { createBlobStorage, handleBlobMultipartUpload, handleBlobUpload } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("storage")))}`)
    imports.push(`import { blobResult, unknownBlobStoreError } from ${JSON.stringify(createImportPath(file, resolveRuntimeModule("errors")))}`)
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
          "function withServedBlobUrl(name, object) {",
          "  const serve = blobConfig?.serve",
          "  if (!serve || serve.store !== name) return object",
          "  return { ...object, url: joinServedBlobUrl(serve.publicBaseUrl || \"/\", serve.route, encodeServedBlobPath(object.pathname)) }",
          "}",
          "",
          "function withServedMultipartUrl(name, upload) {",
          "  return {",
          "    ...upload,",
          "    async complete(parts) {",
          "      const [error, object] = await upload.complete(parts)",
          "      return error ? [error, undefined] : [null, withServedBlobUrl(name, object)]",
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
          "  if (!Object.prototype.hasOwnProperty.call(stores, name)) throw unknownBlobStoreError(name)",
          "  const store = stores[name]",
          "  if (!store) throw unknownBlobStoreError(name)",
          "  return store",
          "}",
          "",
          "function createGeneratedBlobStorage(name = \"default\") {",
          "  const existing = blobStorages.get(name)",
          "  if (existing) return existing",
          "  const storage = createBlobStorage(createBlobDriver(resolveBlobStoreConfig(name)), name)",
          "  const runtimeStorage = {",
          "    ...storage,",
          "    async createMultipartUpload(pathname, options) {",
          "      const [error, upload] = await storage.createMultipartUpload(pathname, options)",
          "      return error ? [error, undefined] : [null, withServedMultipartUrl(name, upload)]",
          "    },",
          "    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(runtimeStorage, event, options),",
          "    handleUpload: (event, options) => handleBlobUpload(runtimeStorage, event, options),",
          "    async resumeMultipartUpload(pathname, uploadId) {",
          "      const [error, upload] = await storage.resumeMultipartUpload(pathname, uploadId)",
          "      return error ? [error, undefined] : [null, withServedMultipartUrl(name, upload)]",
          "    },",
          "    async head(pathname) {",
          "      const [error, object] = await storage.head(pathname)",
          "      return error ? [error, undefined] : [null, object && withServedBlobUrl(name, object)]",
          "    },",
          "    async list(options) {",
          "      const [error, result] = await storage.list(options)",
          "      return error ? [error, undefined] : [null, { ...result, blobs: result.blobs.map(object => withServedBlobUrl(name, object)) }]",
          "    },",
          "    async put(pathname, body, options) {",
          "      const [error, object] = await storage.put(pathname, body, options)",
          "      return error ? [error, undefined] : [null, withServedBlobUrl(name, object)]",
          "    },",
          "    store: storeName => createGeneratedBlobStorage(storeName),",
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
          "    async createMultipartUpload(pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.createMultipartUpload(pathname, options) },",
          "    async handleMultipartUpload(event, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.handleMultipartUpload(event, options) },",
          "    async handleUpload(event, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"upload\"); return error ? [error, undefined] : storage.handleUpload(event, options) },",
          "    async resumeMultipartUpload(pathname, uploadId) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"multipart\"); return error ? [error, undefined] : storage.resumeMultipartUpload(pathname, uploadId) },",
          "    async del(pathnames) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"del\"); return error ? [error, undefined] : storage.del(pathnames) },",
          "    async get(pathname) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"get\"); return error ? [error, undefined] : storage.get(pathname) },",
          "    async head(pathname) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"head\"); return error ? [error, undefined] : storage.head(pathname) },",
          "    async list(options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"list\"); return error ? [error, undefined] : storage.list(options) },",
          "    async put(pathname, body, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"put\"); return error ? [error, undefined] : storage.put(pathname, body, options) },",
          "    async sign(pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"sign\"); return error ? [error, undefined] : storage.sign(pathname, options) },",
          "    async serve(event, pathname, options) { const [error, storage] = await resolveGeneratedBlobStorage(name, \"serve\"); return error ? [error, undefined] : storage.serve(event, pathname, options) },",
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
