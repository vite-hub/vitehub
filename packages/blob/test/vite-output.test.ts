import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { dirname, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build as bundle, transform } from "esbuild"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { contributeProviderRuntime, createProviderOutputCatalog, getProviderRuntimeModule, getVercelRuntimePackages, writeProviderDeploymentOutputs } from "@vite-hub/internal/build/deployment-output"
import { toSafeAppName } from "@vite-hub/internal/build/user-entry"

import { normalizeBlobOptions } from "../src/config.ts"
import { createBundledVercelBlobDriver, createDriver as createInternalVercelBlobDriver } from "../src/drivers/vercel-bundled.ts"
import { generateProviderOutputs, prepareProviderOutputs } from "../src/internal/vite-build.ts"

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

async function createHostedDatabaseRuntimeFixture(rootDir: string, options: { localNodeImport?: boolean } = {}) {
  const packageDir = join(rootDir, "node_modules", "vitehub-hosted-fixture")
  const definitionDefaultsFile = join(rootDir, "database-definition-defaults.mjs")
  const runtimeFile = join(rootDir, "database-runtime.mjs")
  await mkdir(join(rootDir, "src"), { recursive: true })
  await mkdir(packageDir, { recursive: true })
  await writeFile(join(rootDir, "src", "server.ts"), [
    'import { databaseRuntimeMarker } from "@vite-hub/database/drizzle"',
    "export default async () => new Response(databaseRuntimeMarker)",
    "",
  ].join("\n"), "utf8")
  await writeFile(join(packageDir, "package.json"), JSON.stringify({
    exports: {
      ".": {
        "vitehub-hosted": "./hosted.mjs",
        default: "./local.mjs",
      },
    },
    name: "vitehub-hosted-fixture",
    type: "module",
  }), "utf8")
  await writeFile(join(packageDir, "hosted.mjs"), 'export default "hosted-database-runtime-marker"\n', "utf8")
  await writeFile(join(packageDir, "local.mjs"), [
    options.localNodeImport ? 'import "node:fs"' : "",
    'export default "local-database-runtime-marker"',
    "",
  ].join("\n"), "utf8")
  await writeFile(runtimeFile, [
    'import selectedRuntimeMarker from "vitehub-hosted-fixture"',
    'import definitionDefaults from "#vitehub/database/definition-defaults"',
    "const connectionUrl = definitionDefaults.connection?.url",
    "export const databaseRuntimeMarker = `${selectedRuntimeMarker}:${connectionUrl}`",
    "",
  ].join("\n"), "utf8")
  await writeFile(definitionDefaultsFile, 'export default { connection: { url: "libsql://composed.example" } }\n', "utf8")
  const providerOutput = createProviderOutputCatalog()
  contributeProviderRuntime(providerOutput, {
    owner: "database",
    runtimeModules: {
      cloudflare: runtimeFile,
      "cloudflare-definition-defaults": definitionDefaultsFile,
      vercel: runtimeFile,
      "vercel-definition-defaults": definitionDefaultsFile,
    },
  })
  return providerOutput
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
  vi.unstubAllGlobals()
})

describe("Vite provider outputs", () => {
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

  it("rejects malformed resolved Blob config before rendering provider entries", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-invalid-resolved-config-")

    await expect(generateProviderOutputs({
      blob: { store: { access: "private" } } as never,
      clientOutDir: "dist",
      rootDir,
    })).rejects.toThrow("`blob.store` must contain a fully resolved Blob store with a supported `driver`.")
  })

  it("hydrates configured Blob options in bundled server output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-runtime-config-")
    const entry = join(rootDir, "src", "server.ts")
    const configuredBase = join(rootDir, "configured")
    await mkdir(join(rootDir, "node_modules", "@vite-hub"), { recursive: true })
    await symlink(resolve(import.meta.dirname, ".."), join(rootDir, "node_modules", "@vite-hub", "blob"), "dir")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "package.json"), JSON.stringify({ type: "module" }))
    await writeFile(entry, [
      `import vitehubBlobPlugin from "../.vitehub/nitro/blob/plugin.ts"`,
      `import { blob } from "@vite-hub/blob"`,
      `vitehubBlobPlugin()`,
      `const [error, object] = await blob.put("proof.txt", "configured")`,
      `if (error) throw error`,
      `console.log(JSON.stringify(object))`,
      ``,
    ].join("\n"))
    const [{ build }, { hubBlob }] = await Promise.all([
      import("vite"),
      import("../src/vite.ts"),
    ])

    await build({
      appType: "custom",
      blob: {
        base: configuredBase,
        driver: "fs",
        serve: { publicBaseUrl: "https://assets.example" },
      },
      build: {
        outDir: "dist",
        rollupOptions: {
          input: entry,
          output: { entryFileNames: "server.mjs" },
        },
        ssr: entry,
      },
      configFile: false,
      logLevel: "silent",
      plugins: [hubBlob()],
      root: rootDir,
    })

    const { stdout } = await execFileAsync(process.execPath, [join(rootDir, "dist", "server.mjs")], { cwd: rootDir })
    expect(JSON.parse(stdout)).toMatchObject({
      pathname: "proof.txt",
      url: "https://assets.example/api/_vitehub/blob/proof.txt",
    })
    await expect(readFile(join(configuredBase, "proof.txt"), "utf8")).resolves.toBe("configured")
  })

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
    expect(await readFile(cloudflareWorker, "utf8")).toContain("vitehub-blob-worker")
    expect(await readFile(cloudflareConfig, "utf8")).toContain("\"bucket_name\": \"assets\"")
    expect(await readFile(vercelConfig, "utf8")).toContain("\"/__server\"")
    expect(existsSync(vercelServer)).toBe(true)
    expect(vercelServerContents).toContain("/api/blob")
    expect(existsSync(vercelStatic)).toBe(false)
  }, 20_000)

  it("bundles the content-type subpath in provider output", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-content-type-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), [
      'import { detectContentType } from "@vite-hub/blob/content-type"',
      "export default async () => new Response(detectContentType(Uint8Array.from([0xFF, 0xD8, 0xFF])) || 'unknown')",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({ blob: {}, clientOutDir: "dist", rootDir })

    const cloudflareWorker = await readFile(join(rootDir, "dist", toSafeAppName(rootDir), "index.js"), "utf8")
    const vercelServer = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(cloudflareWorker).toContain("image/jpeg")
    expect(vercelServer).toContain("image/jpeg")
  })

  it("selects hosted Database definitions in Blob-owned Cloudflare output", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-hosted-database-cloudflare-")
    const providerOutput = await createHostedDatabaseRuntimeFixture(rootDir, { localNodeImport: true })

    await generateProviderOutputs({
      blob: { bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      providerOutput,
      rootDir,
    })

    const cloudflareWorker = await readFile(join(rootDir, "dist", toSafeAppName(rootDir), "index.js"), "utf8")
    expect(cloudflareWorker).toContain("hosted-database-runtime-marker")
    expect(cloudflareWorker).toContain("libsql://composed.example")
    expect(cloudflareWorker).not.toContain("local-database-runtime-marker")
  })

  it("selects hosted Database definitions in Blob-owned Vercel output", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-hosted-database-vercel-")
    const providerOutput = await createHostedDatabaseRuntimeFixture(rootDir)

    await generateProviderOutputs({
      blob: { bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      providerOutput,
      rootDir,
    })

    const vercelServer = await readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")
    expect(vercelServer).toContain("hosted-database-runtime-marker")
    expect(vercelServer).toContain("libsql://composed.example")
    expect(vercelServer).not.toContain("local-database-runtime-marker")
  })

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

  it("preserves Nitro output when emitting a composed Vercel function", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-nitro-output-")
    const outputRoot = join(rootDir, ".vercel", "output")
    const nitroFunction = join(outputRoot, "functions", "__server.func", "index.mjs")
    const nitroConfig = {
      routes: [{ src: "/(.*)", dest: "/__server" }],
      version: 3,
    }
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(dirname(nitroFunction), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await writeFile(nitroFunction, "export default 'nitro'\n", "utf8")
    await writeFile(join(outputRoot, "config.json"), `${JSON.stringify(nitroConfig, null, 2)}\n`, "utf8")

    await generateProviderOutputs({
      blob: {},
      clientOutDir: "dist",
      rootDir,
      serverFunctionName: "__blob.func",
    })

    await expect(readFile(nitroFunction, "utf8")).resolves.toBe("export default 'nitro'\n")
    await expect(readFile(join(outputRoot, "config.json"), "utf8").then(JSON.parse)).resolves.toEqual(nitroConfig)
    expect(existsSync(join(outputRoot, "functions", "__blob.func", "index.mjs"))).toBe(true)
  })

  it("leaves provider output to Nitro for Cloudflare builds", { timeout: 45_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-nitro-cloudflare-")
    const cloudflareOutput = join(rootDir, "dist", toSafeAppName(rootDir))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await mkdir(cloudflareOutput, { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await writeFile(join(cloudflareOutput, "index.js"), "// workflow worker\nexport default {}\n", "utf8")
    const foreignWrangler = {
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      main: "index.js",
      observability: { enabled: true },
      r2_buckets: [{ binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" }],
      triggers: { crons: ["0 0 * * *"] },
    }
    await writeFile(join(cloudflareOutput, "wrangler.json"), `${JSON.stringify(foreignWrangler, null, 2)}\n`, "utf8")
    const providerOutput = createProviderOutputCatalog()
    contributeProviderRuntime(providerOutput, { owner: "database", runtimeModules: { vercel: "unused" } })

    const options = {
      blob: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      providerOutput,
      rootDir,
      serverFunctionName: "__blob.func",
    } as const
    await generateProviderOutputs({ ...options, serverFunctionName: undefined })

    await expect(readFile(join(cloudflareOutput, "index.js"), "utf8")).resolves.toBe("// workflow worker\nexport default {}\n")
    await expect(readFile(join(cloudflareOutput, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual(foreignWrangler)

    await generateProviderOutputs({ ...options, cloudflareOwnedByNitro: false })
    const currentWorker = await readFile(join(cloudflareOutput, "index.js"), "utf8")
    const legacyWorker = currentWorker.replace("// vitehub-blob-worker\n", "")
    expect(currentWorker).toBe(`// vitehub-blob-worker\n${legacyWorker}`)
    expect(legacyWorker).toContain("function createBlobCloudflareWorker(")
    expect(legacyWorker).toContain("setBlobRuntimeConfig(")
    expect(legacyWorker).toContain("R2 binding")
    await writeFile(join(cloudflareOutput, "index.js"), legacyWorker, "utf8")
    await generateProviderOutputs(options)

    expect(existsSync(join(cloudflareOutput, "index.js"))).toBe(false)
    await expect(readFile(join(cloudflareOutput, "wrangler.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      triggers: { crons: ["0 0 * * *"] },
    })
    expect(existsSync(join(rootDir, ".vercel", "output", "static", toSafeAppName(rootDir), "index.js"))).toBe(false)
    expect(existsSync(join(rootDir, ".vercel", "output", "functions", "__blob.func", "index.mjs"))).toBe(false)
  })

  it("preserves Vercel functions not owned by Blob during Cloudflare builds", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-shared-vercel-")
    const functionFile = join(rootDir, ".vercel/output/functions/__server.func/index.mjs")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src/server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await generateProviderOutputs({ blob: { driver: "vercel-blob" }, clientOutDir: "dist", rootDir })
    await writeFile(functionFile, "// shared server\n", "utf8")

    await generateProviderOutputs({ blob: { driver: "vercel-blob" }, clientOutDir: "dist", cloudflareOwnedByNitro: true, rootDir })

    await expect(readFile(functionFile, "utf8")).resolves.toBe("// shared server\n")
  })

  it("does not register Blob Vercel runtime or packages when Nitro owns Cloudflare output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-nitro-cloudflare-registry-")
    const providerOutput = createProviderOutputCatalog()
    contributeProviderRuntime(providerOutput, { owner: "database", runtimeModules: { vercel: "database-runtime.mjs" } })
    contributeProviderRuntime(providerOutput, {
      owner: "blob",
      runtimeModules: {},
      vercelRuntimePackages: [{ name: "stale-package", resolveFrom: rootDir }],
    })
    const blob = { bucketName: "assets", driver: "cloudflare-r2" as const }

    const artifacts = await prepareProviderOutputs({
      blob,
      cloudflareOwnedByNitro: true,
      providerOutput,
      rootDir,
    })
    expect(getVercelRuntimePackages(providerOutput, "blob")).toEqual([])
    expect(getProviderRuntimeModule(providerOutput, "blob", "cloudflare")).toBeDefined()
    expect(getProviderRuntimeModule(providerOutput, "blob", "vercel")).toBeUndefined()
    expect(getProviderRuntimeModule(providerOutput, "database", "vercel")).toBe("database-runtime.mjs")

    await generateProviderOutputs({
      artifacts,
      blob,
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      providerOutput,
      rootDir,
    })
    expect(getVercelRuntimePackages(providerOutput, "blob")).toEqual([])
  })

  it("does not copy Blob dependencies when Nitro owns Cloudflare output", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-nitro-cloudflare-packages-")
    const functionDir = join(rootDir, ".vercel/output/functions/__server.func")
    await mkdir(functionDir, { recursive: true })
    await writeFile(join(functionDir, "index.mjs"), "export default 'sibling'\n", "utf8")
    const providerOutput = createProviderOutputCatalog()
    contributeProviderRuntime(providerOutput, { owner: "database", runtimeModules: { vercel: "database-runtime.mjs" } })

    await generateProviderOutputs({
      blob: { bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      providerOutput,
      rootDir,
    })

    expect(existsSync(join(functionDir, "node_modules/files-sdk"))).toBe(false)
    expect(existsSync(join(functionDir, "node_modules/@aws-sdk/client-s3"))).toBe(false)
  })

  it("copies Blob dependencies for sibling Vercel output", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-shared-vercel-runtime-")
    const functionDir = join(rootDir, ".vercel/output/functions/__server.func")
    const siblingEntry = join(rootDir, "sibling.mjs")
    await writeFile(siblingEntry, "export default 'sibling'\n", "utf8")
    const providerOutput = createProviderOutputCatalog()
    contributeProviderRuntime(providerOutput, { owner: "database", runtimeModules: { vercel: "database-runtime.mjs" } })

    await generateProviderOutputs({
      blob: { bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      providerOutput,
      rootDir,
    })

    await writeProviderDeploymentOutputs({
      clientOutDir: "dist",
      rootDir,
      vercel: { bundleEntry: siblingEntry, bundleOptions: {} },
    })

    const runtimeProbe = join(functionDir, "runtime-probe.mjs")
    await writeFile(runtimeProbe, [
      `await import("@aws-sdk/client-s3")`,
      `await import("@aws-sdk/lib-storage")`,
      `await import("@aws-sdk/s3-presigned-post")`,
      `await import("@aws-sdk/s3-request-presigner")`,
      "",
    ].join("\n"), "utf8")
    await expect(execFileAsync(process.execPath, [runtimeProbe])).resolves.toMatchObject({ stderr: "", stdout: "" })
  })

  it("preserves the shared root Vercel output during Cloudflare builds", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-root-vercel-")
    const functionFile = join(rootDir, ".vercel/output/functions/__server.func/index.mjs")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src/server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await generateProviderOutputs({ blob: { driver: "vercel-blob" }, clientOutDir: "dist", rootDir })

    await generateProviderOutputs({ blob: { driver: "vercel-blob" }, clientOutDir: "dist", cloudflareOwnedByNitro: true, rootDir })

    expect(existsSync(functionFile)).toBe(true)
    await expect(readFile(functionFile, "utf8")).resolves.toContain("createBlobVercelServer")
  })

  it("cleans legacy standalone workers without R2 runtime code when Nitro takes ownership", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-nitro-non-r2-")
    const cloudflareOutput = join(rootDir, "dist", toSafeAppName(rootDir))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    const options = {
      blob: { driver: "vercel-blob", token: "test-token" },
      clientOutDir: "dist/client",
      rootDir,
    } as const
    await generateProviderOutputs(options)
    const workerPath = join(cloudflareOutput, "index.js")
    const legacyWorker = (await readFile(workerPath, "utf8")).replace("// vitehub-blob-worker\n", "")
    expect(legacyWorker).toContain("function createBlobCloudflareWorker(")
    expect(legacyWorker).toContain("setBlobRuntimeConfig(")
    expect(legacyWorker).not.toContain("R2 binding")
    await writeFile(workerPath, legacyWorker, "utf8")

    await generateProviderOutputs({ ...options, cloudflareOwnedByNitro: true })

    expect(existsSync(workerPath)).toBe(false)
    expect(existsSync(join(cloudflareOutput, "wrangler.json"))).toBe(false)
  })

  it("preserves current Nitro R2 bindings after another primitive replaces the Worker", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-shared-worker-")
    const outputRoot = join(rootDir, "dist", toSafeAppName(rootDir))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    const options = { blob: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" }, clientOutDir: "dist", rootDir } as const
    await generateProviderOutputs(options)
    await writeFile(join(outputRoot, "index.js"), "// workflow worker\n", "utf8")

    await generateProviderOutputs({ ...options, cloudflareOwnedByNitro: true })

    await expect(readFile(join(outputRoot, "index.js"), "utf8")).resolves.toBe("// workflow worker\n")
    expect(await readFile(join(outputRoot, "wrangler.json"), "utf8").then(JSON.parse)).toHaveProperty("r2_buckets")
  })

  it("cleans standalone Cloudflare output when Blob becomes local under Nitro", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-local-nitro-")
    const outputRoot = join(rootDir, "dist", toSafeAppName(rootDir))
    await mkdir(join(rootDir, "src"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")
    await generateProviderOutputs({
      blob: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
      clientOutDir: "dist",
      rootDir,
    })

    await generateProviderOutputs({
      blob: { driver: "fs" },
      clientOutDir: "dist",
      rootDir,
    })

    expect(existsSync(join(rootDir, ".vitehub", "blob", "cloudflare-output.json"))).toBe(false)

    await generateProviderOutputs({
      blob: { driver: "fs" },
      clientOutDir: "dist",
      cloudflareOwnedByNitro: true,
      rootDir,
    })

    expect(existsSync(join(outputRoot, "index.js"))).toBe(false)
    expect(existsSync(join(outputRoot, "wrangler.json"))).toBe(false)
  })

  it("omits Cloudflare bucket bindings when none are configured", { timeout: 15_000 }, async () => {
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

  it("emits Cloudflare bucket bindings for named R2 stores", { timeout: 15_000 }, async () => {
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

  it("bundles Cloudflare provider output without resolving optional R2 HTTP peers", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-cloudflare-r2-externals-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: { driver: "cloudflare-r2", bucketName: "assets" },
      clientOutDir: "dist/client",
      rootDir,
    })

    const cloudflareWorker = await readFile(join(rootDir, "dist", toSafeAppName(rootDir), "index.js"), "utf8")
    expect(cloudflareWorker).not.toContain("files-sdk")
    expect(cloudflareWorker).not.toContain("@aws-sdk/")
  })

  it("copies Cloudflare R2 runtime packages into isolated Vercel output", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-vercel-r2-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: { driver: "cloudflare-r2", bucketName: "assets" },
      clientOutDir: "dist/client",
      rootDir,
      serverFunctionName: "__blob.func",
    })

    const serverEntry = join(rootDir, ".vercel", "output", "functions", "__blob.func", "index.mjs")
    await expect(import(`${pathToFileURL(serverEntry).href}?t=${Date.now()}`)).resolves.toHaveProperty("default")

    const runtimeProbe = join(dirname(serverEntry), "runtime-probe.mjs")
    const runtimeProbeSource = [
      `await import("@aws-sdk/client-s3")`,
      `await import("@aws-sdk/lib-storage")`,
      `await import("@aws-sdk/s3-presigned-post")`,
      `await import("@aws-sdk/s3-request-presigner")`,
      "",
    ].join("\n")
    await writeFile(runtimeProbe, runtimeProbeSource, "utf8")
    await expect(execFileAsync(process.execPath, [runtimeProbe])).resolves.toMatchObject({ stderr: "", stdout: "" })

    const staleFile = join(dirname(serverEntry), "stale.mjs")
    await writeFile(staleFile, "export default true\n", "utf8")
    await generateProviderOutputs({ blob: {}, clientOutDir: "dist/client", rootDir, serverFunctionName: "__blob.func" })
    expect(existsSync(staleFile)).toBe(false)
    await writeFile(runtimeProbe, runtimeProbeSource, "utf8")
    await expect(execFileAsync(process.execPath, [runtimeProbe])).resolves.toMatchObject({ stderr: "", stdout: "" })
  })

  it("copies the private Vercel Blob runtime into isolated Vercel output", { timeout: 15_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-vercel-blob-runtime-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", "client"), { recursive: true })
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: {
        access: "private",
        driver: "vercel-blob",
        token: "vercel_blob_rw_test",
      },
      clientOutDir: "dist/client",
      rootDir,
      serverFunctionName: "__blob.func",
    })

    const runtimeModule = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeModule).toContain("drivers/vercel-bundled")

    const serverEntry = join(rootDir, ".vercel", "output", "functions", "__blob.func", "index.mjs")
    await expect(import(`${pathToFileURL(serverEntry).href}?t=${Date.now()}`)).resolves.toHaveProperty("default")

    const runtimeProbe = join(dirname(serverEntry), "runtime-probe.mjs")
    await writeFile(runtimeProbe, `await import("@vercel/blob")\n`, "utf8")
    await expect(execFileAsync(process.execPath, [runtimeProbe])).resolves.toMatchObject({ stderr: "", stdout: "" })
  })

  it("skips provider output for local fs stores", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-local-fs-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist", toSafeAppName(rootDir)), { recursive: true })
    await mkdir(join(rootDir, ".vercel", "output", "functions", "__server.func"), { recursive: true })
    await writeFile(join(rootDir, "dist", toSafeAppName(rootDir), "index.js"), "existing cloudflare output\n", "utf8")
    await writeFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "existing vercel output\n", "utf8")
    await writeFile(join(rootDir, "src", "server.ts"), "export default async () => new Response('ok')\n", "utf8")

    await generateProviderOutputs({
      blob: { driver: "fs", base: ".vitehub/data/blob" },
      clientOutDir: "dist",
      rootDir,
    })

    await expect(readFile(join(rootDir, "dist", toSafeAppName(rootDir), "index.js"), "utf8")).resolves.toBe("existing cloudflare output\n")
    await expect(readFile(join(rootDir, ".vercel", "output", "functions", "__server.func", "index.mjs"), "utf8")).resolves.toBe("existing vercel output\n")
  })

  it("does not register local fs provider runtimes for composed sibling output", async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-local-fs-registry-")
    const providerOutput = createProviderOutputCatalog()
    const blob = { driver: "fs" as const, base: ".vitehub/data/blob" }

    await prepareProviderOutputs({ blob, providerOutput, rootDir })
    expect(getProviderRuntimeModule(providerOutput, "blob", "cloudflare")).toBeUndefined()
    expect(getProviderRuntimeModule(providerOutput, "blob", "vercel")).toBeUndefined()

    await generateProviderOutputs({ blob, clientOutDir: "dist", providerOutput, rootDir })
    expect(getProviderRuntimeModule(providerOutput, "blob", "cloudflare")).toBeUndefined()
    expect(getProviderRuntimeModule(providerOutput, "blob", "vercel")).toBeUndefined()
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
      },
      clientOutDir: "dist",
      rootDir,
    })

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

    const runtimeContents = await readFile(join(rootDir, ".vitehub", "blob", "vercel-runtime.mjs"), "utf8")
    expect(runtimeContents).toContain("store: storeName => createGeneratedBlobStorage(storeName)")
    expect(runtimeContents).toContain("export const blob = createLazyGeneratedBlobStorage(\"default\")")
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

  it("bundles user provider imports that are unrelated to the selected Blob store", { timeout: 30_000 }, async () => {
    const rootDir = await createWorkspaceTempDir("vitehub-blob-vite-user-provider-import-")
    await mkdir(join(rootDir, "src"), { recursive: true })
    await mkdir(join(rootDir, "dist"), { recursive: true })
    await symlink(resolve(import.meta.dirname, "../node_modules"), join(rootDir, "node_modules"), "dir")
    await writeFile(join(rootDir, "src", "server.ts"), [
      'import { BlobServiceClient } from "@azure/storage-blob"',
      'import { Files } from "files-sdk"',
      "export default async () => new Response(`${BlobServiceClient.name}:${Files.name}`)",
      "",
    ].join("\n"), "utf8")

    await generateProviderOutputs({
      blob: { driver: "vercel-blob", token: "test-token" },
      clientOutDir: "dist",
      rootDir,
    })

    const functionRoot = join(rootDir, ".vercel", "output", "functions", "__server.func")
    const serverContents = await readFile(join(functionRoot, "index.mjs"), "utf8")
    const executableContents = (await transform(serverContents, { legalComments: "none", loader: "js", minifySyntax: true })).code
    expect(executableContents).not.toMatch(/(?:from\s*|import\()\s*["']@azure\//)
    expect(executableContents).not.toMatch(/(?:from\s*|import\()\s*["']files-sdk(?:\/|["'])/)
    expect(existsSync(join(functionRoot, "node_modules", "@azure", "storage-blob"))).toBe(false)
    expect(existsSync(join(functionRoot, "node_modules", "files-sdk"))).toBe(false)
  })

  it("generates MinIO driver reachability for selected stores", { timeout: 30_000 }, async () => {
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
    const [error] = await runtimeModule.blob.put("notes/generated.txt", "hello") as [unknown, unknown]
    expect(error).toBeNull()

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
