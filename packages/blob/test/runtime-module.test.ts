import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build as bundle } from "esbuild"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

import { normalizeBlobOptions } from "../src/config.ts"
import { createBundledVercelBlobDriver, createDriver as createInternalVercelBlobDriver } from "../src/drivers/vercel-bundled.ts"
import { renderBlobRuntimeModule } from "../src/internal/nitro-runtime.ts"

import type { BlobModuleOptions, ResolvedBlobModuleOptions } from "../src/types.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []
const testServers: ReturnType<typeof createServer>[] = []
const vercelBlobMock = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
  get: vi.fn(async (pathname: string) => ({
    blob: {
      cacheControl: "public, max-age=0, must-revalidate",
      contentDisposition: "inline",
      contentType: "text/plain",
      etag: "\"etag\"",
      pathname,
      size: 5,
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      url: `https://blob.example/${pathname}`,
    },
    headers: new Headers(),
    statusCode: 200,
    stream: new Response("value").body,
  })),
  head: vi.fn(async (pathname: string) => ({
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
  list: vi.fn(async () => ({
    blobs: [],
    hasMore: false,
  })),
  put: vi.fn(async (pathname: string) => ({
    contentType: "text/plain",
    key: pathname,
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
}))
vi.mock("@vercel/blob", () => vercelBlobMock)

vi.mock("files-sdk", () => ({
  Files: class {
    adapter: { options?: { access?: "private" | "public", token?: string }, provider?: string }

    constructor(options: { adapter?: { options?: { access?: "private" | "public", token?: string }, provider?: string } } = {}) {
      this.adapter = options.adapter || {}
    }

    async upload(pathname: string, body: Blob | Uint8Array | string, options: { contentType?: string } = {}) {
      const result = await (vercelBlobMock.put as any)(pathname, body, {
        access: this.adapter.options?.access,
        contentType: options.contentType,
        token: this.adapter.options?.token,
      })
      return {
        contentType: result.contentType,
        key: result.pathname,
        lastModified: result.uploadedAt,
        size: result.size,
      }
    }

    async url(pathname: string) {
      return `https://blob.example/${pathname}`
    }
  },
}))

vi.mock("files-sdk/vercel-blob", () => ({
  vercelBlob: (options: unknown) => ({ options, provider: "vercel-blob" }),
}))

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

function resolveVercelBlob(blob: BlobModuleOptions): ResolvedBlobModuleOptions {
  const resolved = normalizeBlobOptions(blob, { hosting: "vercel" })
  if (!resolved) throw new Error("Blob config must resolve to a store.")
  return resolved
}

async function writeVercelRuntimeModule(rootDir: string, resolved: ResolvedBlobModuleOptions) {
  const file = join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")
  await mkdir(join(rootDir, ".vitehub", "blob"), { recursive: true })
  await writeFile(file, renderBlobRuntimeModule(file, resolved, "vercel"), "utf8")
  return file
}

function stubVercelBlobApi() {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url)
    const pathname = url.searchParams.get("pathname") || "unknown"
    const blobUrl = `https://store.public.blob.vercel-storage.com/${pathname}`
    return Response.json({
      contentDisposition: "inline",
      contentType: "text/plain",
      downloadUrl: `${blobUrl}?download=1`,
      etag: '"etag"',
      pathname,
      url: blobUrl,
    })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

afterAll(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

afterEach(async () => {
  await Promise.all(testServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  delete process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.MINIO_ACCESS_KEY_ID
  delete process.env.MINIO_ROOT_PASSWORD
  delete process.env.MINIO_ROOT_USER
  delete process.env.MINIO_SECRET_ACCESS_KEY
  vercelBlobMock.del.mockClear()
  vercelBlobMock.get.mockClear()
  vercelBlobMock.head.mockClear()
  vercelBlobMock.list.mockClear()
  vercelBlobMock.put.mockClear()
  vi.unstubAllGlobals()
})

describe("Blob Nitro runtime module", () => {
  it.each([
    { objectAccess: "private" as const, storeAccess: "public" as const },
    { objectAccess: "public" as const, storeAccess: "private" as const },
  ])("reads a $objectAccess Vercel object when per-put access differs from the $storeAccess store default", async ({ objectAccess, storeAccess }) => {
    const pathname = "images/private.txt"
    const canonicalUrl = `https://store.${objectAccess}.blob.vercel-storage.com/${pathname}`
    vercelBlobMock.head.mockResolvedValueOnce({
      pathname,
      size: 5,
      uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
      url: canonicalUrl,
    })
    const anonymousFetch = vi.fn(async () => new Response(null, {
      status: 403,
      statusText: "Forbidden",
    }))
    vi.stubGlobal("fetch", anonymousFetch)
    const driver = createInternalVercelBlobDriver({
      access: storeAccess,
      driver: "vercel-blob",
      token: "vercel_blob_rw_test",
    })

    await driver.put(pathname, "value", { access: objectAccess })
    const value = await driver.getArrayBuffer(pathname)
    expect(new TextDecoder().decode(value || undefined)).toBe("value")
    expect(vercelBlobMock.put).toHaveBeenCalledWith(pathname, "value", expect.objectContaining({ access: objectAccess }))
    expect(vercelBlobMock.get).toHaveBeenCalledWith(canonicalUrl, expect.objectContaining({
      access: objectAccess,
      token: "vercel_blob_rw_test",
    }))
    expect(anonymousFetch).not.toHaveBeenCalled()
  })

  it("maps Vercel missing-object errors to Blob misses", async () => {
    const missing = new Error("Vercel Blob: The requested blob does not exist")
    missing.name = "BlobNotFoundError"
    vercelBlobMock.head.mockRejectedValueOnce(missing)
    const driver = createBundledVercelBlobDriver({
      access: "private",
      driver: "vercel-blob",
      token: "vercel_blob_rw_test",
    })

    await expect(driver.head("missing.txt")).resolves.toBeNull()

    const missingStore = new Error("Vercel Blob: The requested store does not exist")
    vercelBlobMock.head.mockRejectedValueOnce(missingStore)
    await expect(driver.head("missing.txt")).rejects.toBe(missingStore)
  })

  it("rejects custom metadata that Vercel Blob cannot persist", async () => {
    const driver = createBundledVercelBlobDriver({
      access: "private",
      driver: "vercel-blob",
      token: "vercel_blob_rw_test",
    })

    await expect(driver.put("metadata.txt", "value", {
      customMetadata: { owner: "vitehub" },
    })).rejects.toThrow("does not support custom metadata")
    expect(vercelBlobMock.put).not.toHaveBeenCalled()
  })

  it("loads the fs driver from bundled SSR output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-bundled-fs-")
    const entryFile = join(rootDir, "entry.ts")
    const bundleFile = join(rootDir, "server.mjs")

    await writeFile(entryFile, [
      `import { blob } from ${JSON.stringify(resolve(import.meta.dirname, "../src/index.ts"))}`,
      "const [putError] = await blob.put('proof.txt', 'ok')",
      "if (putError) throw putError",
      "const [getError, object] = await blob.get('proof.txt')",
      "if (getError) throw getError",
      "console.log(await object?.text())",
      "",
    ].join("\n"), "utf8")

    await bundle({
      bundle: true,
      entryPoints: [entryFile],
      format: "esm",
      logLevel: "silent",
      outfile: bundleFile,
      platform: "node",
      target: "es2022",
    })

    const { stdout } = await execFileAsync(process.execPath, [bundleFile], { cwd: rootDir })
    expect(stdout.trim()).toBe("ok")
  })

  it("statically reaches only the native Cloudflare R2 driver from bundled SSR output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-bundled-r2-")
    const entryFile = join(rootDir, "entry.ts")
    const bundleFile = join(rootDir, "worker.mjs")

    await writeFile(entryFile, [
      `import { blob } from ${JSON.stringify(resolve(import.meta.dirname, "../src/index.ts"))}`,
      `import { setBlobRuntimeConfig } from ${JSON.stringify(resolve(import.meta.dirname, "../src/runtime/state.ts"))}`,
      "setBlobRuntimeConfig({ store: { binding: 'BLOB', driver: 'cloudflare-r2' } })",
      "const [error] = await blob.put('proof.txt', 'ok')",
      "if (error) throw error",
      "",
    ].join("\n"), "utf8")

    await bundle({
      bundle: true,
      entryPoints: [entryFile],
      external: ["node:async_hooks"],
      format: "esm",
      logLevel: "silent",
      outfile: bundleFile,
      platform: "neutral",
      target: "es2022",
    })

    const bundled = await readFile(bundleFile, "utf8")
    expect(bundled).not.toContain("@vite-hub/blob/drivers/cloudflare")
    expect(bundled).toContain("config.driver === \"cloudflare-r2\"")
    expect(bundled).toContain("R2 binding")
    expect(bundled).not.toContain("files-sdk")
    expect(bundled).not.toContain("@aws-sdk/")
  })

  it("rehydrates masked Vercel tokens from generated runtime output", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-vercel-runtime-")

    await writeVercelRuntimeModule(rootDir, resolveVercelBlob({}))

    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    const fetchMock = stubVercelBlobApi()
    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        put: (pathname: string, body: string) => Promise<unknown>
        store: (name: string) => {
          put: (pathname: string, body: string) => Promise<unknown>
        }
      }
    }

    const [error] = await runtimeModule.blob.put("notes/generated.txt", "hello") as [unknown, unknown]
    expect(error).toBeNull()

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("pathname=notes%2Fgenerated.txt"),
      expect.objectContaining({ method: "PUT" }),
    )

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("resolveRuntimeVercelBlobStore")
    expect(runtimeContents).toContain("createDriver0(resolveRuntimeVercelBlobStore(store, process.env))")
  })

  it("selects named stores from generated runtime output", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-named-runtime-")

    await writeVercelRuntimeModule(rootDir, resolveVercelBlob({
      serve: { route: "/", store: "assets" },
      stores: {
        assets: {
          access: "public",
          driver: "vercel-blob",
          token: "assets-token",
        },
        default: {
          access: "public",
          driver: "vercel-blob",
          token: "default-token",
        },
      },
    }))

    const fetchMock = stubVercelBlobApi()
    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        store: (name: string) => {
          put: (pathname: string, body: string) => Promise<unknown>
        }
      }
    }

    const [error, object] = await runtimeModule.blob.store("assets").put("notes/assets.txt", "hello") as [unknown, { url?: string }]
    expect(error).toBeNull()
    expect(object).toMatchObject({ url: "/notes/assets.txt" })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("pathname=notes%2Fassets.txt"),
      expect.objectContaining({ method: "PUT" }),
    )

    await expect(runtimeModule.blob.store("missing").put("notes/missing.txt", "hello")).rejects.toMatchObject({
      code: "BLOB_R0028",
      message: "Unknown Blob store \"missing\".",
    })

    fetchMock.mockClear()
    await expect(runtimeModule.blob.store("constructor").put("notes/constructor.txt", "hello")).rejects.toMatchObject({
      code: "BLOB_R0028",
      message: "Unknown Blob store \"constructor\".",
    })
    expect(fetchMock).not.toHaveBeenCalled()

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("store: storeName => createGeneratedBlobStorage(storeName)")
    expect(runtimeContents).toContain("export const blob = createLazyGeneratedBlobStorage(\"default\")")
  })

  it("generates Netlify Blobs driver reachability for selected stores", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-netlify-runtime-")

    const netlifyBlob = normalizeBlobOptions({}, { hosting: "netlify" })
    if (!netlifyBlob) throw new Error("Netlify Blob config must resolve to a store.")
    await writeVercelRuntimeModule(rootDir, netlifyBlob)

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("drivers/netlify-blobs")
    expect(runtimeContents).toContain("\"driver\": \"netlify-blobs\"")
    expect(runtimeContents).toContain("\"name\": \"vitehub-blob\"")
  })

  it("generates MinIO driver reachability for selected stores", { timeout: 30_000 }, async () => {
    let authorization: string | undefined
    const server = createServer((request, response) => {
      authorization = request.headers.authorization
      response.writeHead(200, { etag: '"etag"' })
      response.end()
    })
    testServers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", resolve)
    })
    // SAFETY: This server listens on a TCP host and port, so Node returns AddressInfo rather than a pipe name.
    const address = server.address() as AddressInfo | null
    if (!address) throw new Error("Missing MinIO test server address.")
    const endpoint = `http://127.0.0.1:${address.port}`

    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-minio-runtime-")
    const blobConfig = normalizeBlobOptions({ driver: "minio" }, {
      env: {
        BLOB_BUCKET_NAME: "assets",
        MINIO_ENDPOINT: endpoint,
        MINIO_ROOT_PASSWORD: "build-password",
        MINIO_ROOT_USER: "build-user",
      },
    })

    if (!blobConfig) throw new Error("MinIO Blob config must resolve to a store.")
    await writeVercelRuntimeModule(rootDir, blobConfig)

    process.env.MINIO_ROOT_PASSWORD = "runtime-password"
    process.env.MINIO_ROOT_USER = "runtime-user"
    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        put: (pathname: string, body: string) => Promise<unknown>
      }
    }
    const [error] = await runtimeModule.blob.put("notes/generated.txt", "hello") as [unknown, unknown]
    expect(error).toBeNull()

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")

    expect(runtimeContents).toContain("drivers/minio")
    expect(runtimeContents).toContain("\"driver\": \"minio\"")
    expect(runtimeContents).toContain(`"endpoint": "${endpoint}"`)
    expect(runtimeContents).toContain("resolveRuntimeMinioBlobStore")
    expect(runtimeContents).toContain("createDriver0(resolveRuntimeMinioBlobStore(store, process.env))")
    expect(runtimeContents).toContain("\"accessKeyId\": \"********\"")
    expect(runtimeContents).toContain("\"secretAccessKey\": \"********\"")
    expect(runtimeContents).not.toContain("build-user")
    expect(runtimeContents).not.toContain("build-password")
    expect(authorization).toContain("Credential=runtime-user/")
    expect(runtimeContents).not.toContain("drivers/s3")
  })
})
