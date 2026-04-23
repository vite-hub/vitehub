import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { toSafeAppName } from "@vitehub/internal/build/user-entry"

import { generateProviderOutputs } from "../src/internal/vite-build.ts"

const execFileAsync = promisify(execFile)
const playgroundDir = resolve(import.meta.dirname, "../../../playground/vite")
const tempDirs: string[] = []
const vercelBlobMock = vi.hoisted(() => ({
  del: vi.fn(async () => {}),
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
    pathname,
    size: 5,
    uploadedAt: new Date("2026-01-01T00:00:00.000Z"),
    url: `https://blob.example/${pathname}`,
  })),
}))

vi.mock("@vercel/blob", () => ({
  del: vercelBlobMock.del,
  head: vercelBlobMock.head,
  list: vercelBlobMock.list,
  put: vercelBlobMock.put,
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
  vercelBlobMock.del.mockClear()
  vercelBlobMock.head.mockClear()
  vercelBlobMock.list.mockClear()
  vercelBlobMock.put.mockClear()
})

describe("Vite provider outputs", () => {
  it("builds the playground and emits Cloudflare and Vercel outputs", async () => {
    await execFileAsync("pnpm", ["exec", "vite", "build"], {
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
    expect(runtimeContents).toContain("resolveRuntimeVercelBlobStore")
    expect(runtimeContents).toContain("createDriver(resolveRuntimeVercelBlobStore(blobConfig.store, process.env))")
  })
})
