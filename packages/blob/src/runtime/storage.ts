import { createBlobStorage } from "../storage.ts"
import { Diagnostic } from "nostics"
import { blobResult, unknownBlobStoreMessage } from "../errors.ts"
import { handleBlobMultipartUpload, handleBlobUpload } from "../upload.ts"
import { createLazyBlobMedia } from "../media/lazy.ts"
import { blobStoreMode, readonlyBlobStorage } from "../readonly.ts"
import { resolveRuntimeBlobSecrets, resolveRuntimeMinioBlobStore, resolveRuntimeVercelBlobStore } from "../config.ts"
import { createDriver as createCloudflareR2NativeDriver, getOptionalBucket } from "../drivers/cloudflare-native.ts"

import { blobRuntimeEnv, getBlobRuntimeConfig, resolveNamedBlobRuntimeStorage } from "./state.ts"
import { getViteHubTestMode } from "@vite-hub/runtime/internal/test-mode"

import type { Result } from "@vite-hub/runtime"

import type { BlobDriverAdapter, BlobErrorCode, BlobMultipartUpload, BlobObject, BlobOperation, BlobStorage, BlobStoreName, BlobStoreOptions, ReadonlyBlobStorage, ResolvedBlobModuleOptions, ResolvedBlobStoreConfig, ResolvedCloudflareR2BlobStoreConfig } from "../types.ts"
import { blobErrorDiagnostics } from "../error-diagnostics.ts"

class UnknownBlobStoreError extends Diagnostic {
  constructor(message: string) {
    super({ code: "BLOB_R0027", docs: "https://vitehub.dev/docs/blob/diagnostics/blob_r0027", why: message, fix: blobErrorDiagnostics.BLOB_R0027({ message }).fix }, UnknownBlobStoreError)
    this.name = "UnknownBlobStoreError"
  }
}

const driverModules = {
  azure: "azure",
  "cloudflare-r2": "cloudflare",
  fs: "fs",
  gcs: "gcs",
  minio: "minio",
  "netlify-blobs": "netlify-blobs",
  s3: "s3",
  "vercel-blob": "vercel",
} satisfies Record<ResolvedBlobStoreConfig["driver"], string>

async function importRuntimeDriver(config: ResolvedBlobStoreConfig) {
  if (config.driver === "cloudflare-r2") {
    // In `vite dev`, a store that the Cloudflare preset picks uses its local `fs` store when the dev runner has no R2 binding.
    if (config.localFallback && !getOptionalBucket(config)) return importRuntimeDriverModule(config.localFallback)
    const nativeDriver = createCloudflareR2NativeDriver(config)
    let fallbackDriver: Promise<BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig>> | undefined
    const activeDriver = async () => {
      if (getOptionalBucket(config)) return nativeDriver
      // A failed load lets the next call try again.
      fallbackDriver ||= importRuntimeDriverModule(config).catch((error: unknown) => {
        fallbackDriver = undefined
        throw error
      })
      return fallbackDriver
    }
    // Multipart uploads use the R2 binding API; the HTTP fallback has no multipart support.
    const multipartBucket = () => {
      if (!getOptionalBucket(config)) {
        throw blobErrorDiagnostics.BLOB_R0030({ message: `Cloudflare R2 multipart uploads require the "${config.binding}" R2 binding.` })
      }
      return nativeDriver
    }
    return {
      name: config.driver,
      options: config,
      createMultipartUpload: async (pathname, options) => multipartBucket().createMultipartUpload!(pathname, options),
      resumeMultipartUpload: async (pathname, uploadId) => multipartBucket().resumeMultipartUpload!(pathname, uploadId),
      copy: async (from, to) => (await activeDriver()).copy!(from, to),
      delete: async pathnames => (await activeDriver()).delete(pathnames),
      get: async pathname => (await activeDriver()).get(pathname),
      getArrayBuffer: async pathname => (await activeDriver()).getArrayBuffer(pathname),
      getStream: async (pathname, options) => (await activeDriver()).getStream!(pathname, options),
      head: async pathname => (await activeDriver()).head(pathname),
      list: async options => (await activeDriver()).list(options),
      put: async (pathname, body, options) => (await activeDriver()).put(pathname, body, options),
      sign: (pathname, options, context) => nativeDriver.sign!(pathname, options, context),
    } satisfies BlobDriverAdapter<ResolvedCloudflareR2BlobStoreConfig>
  }

  return importRuntimeDriverModule(config)
}

async function importRuntimeDriverModule(config: ResolvedBlobStoreConfig) {
  const isSourceRuntime = typeof import.meta !== "undefined"
    && typeof import.meta.url === "string"
    && import.meta.url.endsWith(".ts")

  const moduleName = driverModules[config.driver]
  const modulePath = isSourceRuntime
    ? new URL(`../drivers/${moduleName}.ts`, import.meta.url).href
    : `@vite-hub/blob/drivers/${moduleName}`
  const module = await import(modulePath) as { createDriver: (options: typeof config) => any }
  return module.createDriver(config)
}

function resolveRuntimeBlobStore(configured: ResolvedBlobStoreConfig): ResolvedBlobStoreConfig {
  const store = resolveRuntimeBlobSecrets(configured, blobRuntimeEnv())
  if (store.driver === "minio") {
    return resolveRuntimeMinioBlobStore(store, process.env)
  }
  if (store.driver === "vercel-blob") {
    return resolveRuntimeVercelBlobStore(store, process.env)
  }
  return store
}

async function createConfiguredBlobStorage(config: ResolvedBlobModuleOptions, name: string): Promise<BlobStorage> {
  const resolvedConfig = {
    ...config,
    store: resolveRuntimeBlobStore(config.store),
  }
  const driver = await importRuntimeDriver(resolvedConfig.store)
  return createBlobStorage(driver, name, {
    ...(config.images === undefined ? {} : { images: config.images }),
    url: pathname => servedBlobUrl(name, pathname),
  })
}

function joinServedBlobUrl(...parts: string[]): string {
  const [first, ...rest] = parts.filter(Boolean)
  if (!first) return ""
  const base = first.replace(/\/+$/, "")
  const path = rest.map(part => part.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/")
  if (!base) return path ? `/${path}` : "/"
  return path ? `${base}/${path}` : base
}

function encodeServedBlobPath(pathname: string): string {
  return pathname.split("/").map(segment => encodeURIComponent(segment)).join("/")
}

async function servedBlobUrl(name: string, pathname: string): Promise<string | undefined> {
  const config = await getBlobRuntimeConfig()
  const serve = config && typeof config === "object" ? config.serve : undefined
  if (!serve || serve.store !== name) return undefined
  return joinServedBlobUrl(serve.publicBaseUrl || "/", serve.route, encodeServedBlobPath(pathname))
}

async function withServedBlobUrl(name: string, object: BlobObject): Promise<BlobObject> {
  const url = await servedBlobUrl(name, object.pathname)
  return url ? { ...object, url } : object
}

function resolveBlobStorageConfig(config: false | ResolvedBlobModuleOptions, name: string) {
  if (!config) throw blobErrorDiagnostics.BLOB_R0023({ message: "Blob runtime is disabled." })
  const stores = config.stores || { default: config.store }
  const store = Object.hasOwn(stores, name) ? stores[name] : undefined
  if (!store) throw new UnknownBlobStoreError(unknownBlobStoreMessage(name, stores))
  return { ...(config.images === undefined ? {} : { images: config.images }), store, stores: { default: store, [name]: store } }
}

async function resolveStorage(name = "default"): Promise<BlobStorage> {
  // In app tests, each store is a fresh fs folder that the next reset deletes.
  const test = getViteHubTestMode()
  if (test) {
    const config = resolveBlobStorageConfig(await getBlobRuntimeConfig(), name)
    return test.backend(`blob:${name}`, async () => {
      const store = { base: await test.directory(`blob-${name}`), driver: "fs" } as const
      return await createConfiguredBlobStorage({ ...config, store, stores: { default: store, [name]: store } }, name)
    })
  }
  return resolveNamedBlobRuntimeStorage(name, async (config) => {
    return await createConfiguredBlobStorage(resolveBlobStorageConfig(config, name), name)
  })
}

async function resolveStorageResult(operation: BlobOperation, name: string): Promise<Result<BlobStorage, BlobErrorCode>> {
  const result = await blobResult(operation, name, () => resolveStorage(name))
  if (result[0]?.cause instanceof UnknownBlobStoreError) throw result[0].cause
  return result
}

// Completed multipart objects get the served URL, like put().
function withServedMultipartUrl(name: string, upload: BlobMultipartUpload): BlobMultipartUpload {
  return {
    ...upload,
    async complete(parts) {
      const [error, object] = await upload.complete(parts)
      return error ? [error, undefined] : [undefined, await withServedBlobUrl(name, object)]
    },
  }
}

function createRuntimeBlobStorage(name = "default"): BlobStorage {
  const storage: BlobStorage = {
    media: createLazyBlobMedia(() => resolveStorageResult("media", name)),
    async copy(from, to, options) {
      const [resolutionError, storage] = await resolveStorageResult("copy", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, object] = await storage.copy(from, to, options)
      return error ? [error, undefined] : [undefined, await withServedBlobUrl(name, object)]
    },
    async createMultipartUpload(pathname, options) {
      const [resolutionError, resolved] = await resolveStorageResult("multipart", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, upload] = await resolved.createMultipartUpload(pathname, options)
      return error ? [error, undefined] : [undefined, withServedMultipartUrl(name, upload)]
    },
    handleMultipartUpload: (event, options) => handleBlobMultipartUpload(storage, event, options),
    handleUpload: (event, options) => handleBlobUpload(storage, event, options),
    async resumeMultipartUpload(pathname, uploadId) {
      const [resolutionError, resolved] = await resolveStorageResult("multipart", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, upload] = await resolved.resumeMultipartUpload(pathname, uploadId)
      return error ? [error, undefined] : [undefined, withServedMultipartUrl(name, upload)]
    },
    async delete(pathnames) {
      const [error, storage] = await resolveStorageResult("delete", name)
      return error ? [error, undefined] : storage.delete(pathnames)
    },
    async get(pathname) {
      const [error, storage] = await resolveStorageResult("get", name)
      return error ? [error, undefined] : storage.get(pathname)
    },
    async head(pathname) {
      const [resolutionError, storage] = await resolveStorageResult("head", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, object] = await storage.head(pathname)
      return error ? [error, undefined] : [undefined, object && await withServedBlobUrl(name, object)]
    },
    async list(options) {
      const [resolutionError, storage] = await resolveStorageResult("list", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, result] = await storage.list(options)
      return error
        ? [error, undefined]
        : [undefined, { ...result, blobs: await Promise.all(result.blobs.map(object => withServedBlobUrl(name, object))) }]
    },
    async put(pathname, body, options) {
      const [resolutionError, storage] = await resolveStorageResult("put", name)
      if (resolutionError) return [resolutionError, undefined]
      const [error, object] = await storage.put(pathname, body, options)
      return error ? [error, undefined] : [undefined, await withServedBlobUrl(name, object)]
    },
    async sign(pathname, options) {
      const [error, storage] = await resolveStorageResult("sign", name)
      return error ? [error, undefined] : storage.sign(pathname, options)
    },
    async serve(request, pathname, options) {
      const [error, storage] = await resolveStorageResult("serve", name)
      if (error) throw error
      return storage.serve(request, pathname, options)
    },
    store: selectRuntimeBlobStore,
  }
  return storage
}

function selectRuntimeBlobStore(name: BlobStoreName, options?: { mode?: "write" }): BlobStorage
function selectRuntimeBlobStore(name: BlobStoreName, options: { mode: "read" }): ReadonlyBlobStorage
function selectRuntimeBlobStore(name: BlobStoreName, options?: BlobStoreOptions): BlobStorage | ReadonlyBlobStorage
function selectRuntimeBlobStore(name: BlobStoreName, options?: BlobStoreOptions): BlobStorage | ReadonlyBlobStorage {
  const mode = blobStoreMode(options)
  const storage = createRuntimeBlobStorage(name)
  return mode === "read" ? readonlyBlobStorage(storage) : storage
}

export const blob: BlobStorage = /* @__PURE__ */ createRuntimeBlobStorage()
