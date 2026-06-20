import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { toSafeAppName } from "@vite-hub/internal/build/user-entry"

import { normalizeBlobOptions } from "../src/config.ts"
import { generateProviderOutputs } from "../src/internal/vite-build.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []
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
const filesSdkMock = vi.hoisted(() => ({
  minio: vi.fn((options: unknown) => ({ options, provider: "minio" })),
}))

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

vi.mock("files-sdk/minio", () => ({
  minio: filesSdkMock.minio,
}))

async function createWorkspaceTempDir(prefix: string) {
  const baseDir = join(playgroundDir, ".vitest-tmp")
  await mkdir(baseDir, { recursive: true })
  const rootDir = await mkdtemp(join(baseDir, prefix))
  tempDirs.push(rootDir)
  return rootDir
}

beforeAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
})

afterAll(async () => {
  await rm(join(playgroundDir, "dist"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vercel"), { force: true, recursive: true })
  await rm(join(playgroundDir, ".vitehub"), { force: true, recursive: true })
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { force: true, recursive: true })))
})

afterEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN
  delete process.env.MINIO_ACCESS_KEY_ID
  delete process.env.MINIO_ROOT_PASSWORD
  delete process.env.MINIO_ROOT_USER
  delete process.env.MINIO_SECRET_ACCESS_KEY
  filesSdkMock.minio.mockClear()
  vercelBlobMock.del.mockClear()
  vercelBlobMock.get.mockClear()
  vercelBlobMock.head.mockClear()
  vercelBlobMock.list.mockClear()
  vercelBlobMock.put.mockClear()
})

describe("Vite provider outputs", () => {
  it("builds the playground and emits Cloudflare and Vercel outputs", async () => {
    await execFileAsync("vp", ["build"], {
      cwd: playgroundDir,
      env: {
        ...process.env,
        BLOB_BUCKET_NAME: "assets",
        VITEHUB_VITE_MODE: "blob",
      },
    })

    const cloudflareWorker = join(playgroundDir, "dist", "vite", "index.js")
    const cloudflareConfig = join(playgroundDir, "dist", "vite", "wrangler.json")
    const vercelConfig = join(playgroundDir, ".vercel", "output", "config.json")
    const vercelServer = join(playgroundDir, ".vercel", "output", "functions", "__server.func", "index.mjs")
    const vercelStatic = join(playgroundDir, ".vercel", "output", "static")
    const vercelServerContents = await readFile(vercelServer, "utf8")

    expect(existsSync(cloudflareWorker)).toBe(true)
    expect(await readFile(cloudflareConfig, "utf8")).toContain("\"bucket_name\": \"assets\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(vercelServerContents).toContain("/api/blob")
    expect(existsSync(vercelStatic)).toBe(false)
  }, 20_000)

  it("copies Vercel static output from Vite's default dist directory", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-default-dist-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await writeFile(join(rootDir, "dist", "index.html"), "<!doctype html><title>vitehub</title>\n", "utf8")

    await generateProviderOutputs({
      blob: {},
      clientOutDir: "dist",
      rootDir,
    })

    expect(await readFile(join(rootDir, ".vercel", "output", "static", "index.html"), "utf8")).toContain("<title>vitehub</title>")
  })

  it("omits Cloudflare bucket bindings when none are configured", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-no-bucket-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: { driver: "cloudflare-r2" },
      clientOutDir: "dist/client",
      rootDir,
    })

    expect(await readFile(join(rootDir, "dist", toSafeAppName(rootDir), "wrangler.json"), "utf8")).not.toContain("\"r2_buckets\"")
  })

  it("emits Cloudflare bucket bindings for named R2 stores", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-named-r2-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: {
        stores: {
          assets: {
            binding: "ASSETS",
            bucketName: "assets",
            driver: "cloudflare-r2",
          },
          assetsAlias: {
            binding: "ASSETS",
            bucketName: "assets",
            driver: "cloudflare-r2",
          },
          default: {
            binding: "DEFAULT",
            driver: "cloudflare-r2",
          },
        },
      },
      clientOutDir: "dist/client",
      rootDir,
    })

    const wranglerConfig = JSON.parse(await readFile(join(rootDir, "dist", toSafeAppName(rootDir), "wrangler.json"), "utf8")) as {
      r2_buckets?: Array<{ binding: string, bucket_name: string }>
    }
    expect(wranglerConfig.r2_buckets).toEqual([
      {
        binding: "ASSETS",
        bucket_name: "assets",
      },
    ])
  })

  it("rehydrates masked Vercel tokens from generated runtime output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-vercel-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: {},
      clientOutDir: "dist",
      rootDir,
    })

    process.env.BLOB_READ_WRITE_TOKEN = "secret-token"
    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        put: (pathname: string, body: string) => Promise<unknown>
        store: (name: string) => {
          put: (pathname: string, body: string) => Promise<unknown>
        }
      }
    }

    await runtimeModule.blob.put("notes/generated.txt", "hello")

    expect(vercelBlobMock.put).toHaveBeenCalledWith(
      "notes/generated.txt",
      "hello",
      expect.objectContaining({
        token: "secret-token",
      }),
    )

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    const vercelServerContents = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(runtimeContents).toContain("resolveRuntimeVercelBlobStore")
    expect(runtimeContents).toContain("createDriver0(resolveRuntimeVercelBlobStore(store, process.env))")
    expect(vercelServerContents).not.toContain("from \"@vercel/blob\"")
    expect(vercelServerContents).not.toContain("from '@vercel/blob'")
  })

  it("selects named stores from generated runtime output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-named-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: {
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
      },
      clientOutDir: "dist",
      rootDir,
    })

    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        store: (name: string) => {
          put: (pathname: string, body: string) => Promise<unknown>
        }
      }
    }

    await runtimeModule.blob.store("assets").put("notes/assets.txt", "hello")

    expect(vercelBlobMock.put).toHaveBeenCalledWith(
      "notes/assets.txt",
      "hello",
      expect.objectContaining({
        token: "assets-token",
      }),
    )

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("store: storeName => createGeneratedBlobStorage(storeName)")
    expect(runtimeContents).toContain("export const blob = createGeneratedBlobStorage()")
  })

  it("generates Netlify Blobs driver reachability for selected stores", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-netlify-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: normalizeBlobOptions({}, { hosting: "netlify" }),
      clientOutDir: "dist",
      rootDir,
    })

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("drivers/netlify-blobs")
    expect(runtimeContents).toContain("\"driver\": \"netlify-blobs\"")
    expect(runtimeContents).toContain("\"name\": \"vitehub-blob\"")
  })

  it("generates MinIO driver reachability for selected stores", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-minio-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    const blobConfig = normalizeBlobOptions({ driver: "minio" }, {
      env: {
        BLOB_BUCKET_NAME: "assets",
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_ROOT_PASSWORD: "build-password",
        MINIO_ROOT_USER: "build-user",
      },
    })

    await generateProviderOutputs({
      blob: blobConfig,
      clientOutDir: "dist",
      rootDir,
    })

    process.env.MINIO_ROOT_PASSWORD = "runtime-password"
    process.env.MINIO_ROOT_USER = "runtime-user"
    const runtimeModulePath = `${pathToFileURL(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs")).href}?t=${Date.now()}`
    const runtimeModule = await import(runtimeModulePath) as {
      blob: {
        put: (pathname: string, body: string) => Promise<unknown>
      }
    }
    await runtimeModule.blob.put("notes/generated.txt", "hello")

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    const vercelServerContents = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")

    expect(runtimeContents).toContain("drivers/minio")
    expect(runtimeContents).toContain("\"driver\": \"minio\"")
    expect(runtimeContents).toContain("\"endpoint\": \"http://minio:9000\"")
    expect(runtimeContents).toContain("resolveRuntimeMinioBlobStore")
    expect(runtimeContents).toContain("createDriver0(resolveRuntimeMinioBlobStore(store, process.env))")
    expect(runtimeContents).toContain("\"accessKeyId\": \"********\"")
    expect(runtimeContents).toContain("\"secretAccessKey\": \"********\"")
    expect(runtimeContents).not.toContain("build-user")
    expect(runtimeContents).not.toContain("build-password")
    expect(vercelServerContents).toContain("resolveRuntimeMinioBlobStore")
    expect(vercelServerContents).not.toContain("build-user")
    expect(vercelServerContents).not.toContain("build-password")
    expect(filesSdkMock.minio).toHaveBeenCalledWith(expect.objectContaining({
      accessKeyId: "runtime-user",
      secretAccessKey: "runtime-password",
    }))
    expect(runtimeContents).not.toContain("drivers/s3")
  })
})
