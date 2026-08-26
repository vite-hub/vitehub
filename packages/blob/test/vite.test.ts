import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build as bundle } from "esbuild"
import { H3Event, toResponse } from "h3"
import { describe, expect, it, vi } from "vitest"
import { toSafeAppName } from "@vite-hub/internal/build/user-entry"

import { BLOB_VIRTUAL_CONFIG_ID, hubBlob } from "../src/vite.ts"

const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, "../../..")

async function runProviderOutputHooks(plugin: ReturnType<typeof hubBlob>) {
  await (plugin.buildEnd as () => void | Promise<void>)()
  await (plugin.closeBundle as { handler: () => void | Promise<void> }).handler()
}

function driverImports(source: string) {
  return source.match(/from\s+["'][^"']+\/drivers\/[^"']+["']/g) || []
}

describe("hubBlob", () => {
  it("uses the bundled driver in the Nitro Vercel shared runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-vercel-runtime-"))
    try {
      const plugin = hubBlob({ access: "private", driver: "vercel-blob" })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
        build: { outDir: "dist" },
        nitro: { preset: "vercel" },
        plugins: [{ name: "nitro:main" }],
        root,
      } as never)

      const runtime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
      expect(runtime).toContain("/drivers/vercel-bundled")
      expect(runtime).not.toContain('/drivers/vercel"')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses the bundled driver when Vercel is detected from the environment", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-vercel-env-runtime-"))
    vi.stubEnv("VERCEL", "1")
    try {
      const plugin = hubBlob({ access: "private", driver: "vercel-blob" })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
        build: { outDir: "dist" },
        plugins: [{ name: "nitro:main" }],
        root,
      } as never)

      const runtime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
      expect(runtime).toContain("/drivers/vercel-bundled")
    }
    finally {
      vi.unstubAllEnvs()
      await rm(root, { force: true, recursive: true })
    }
  })

  it("resolves Blob config from the Vite layer", () => {
    const plugin = hubBlob({ driver: "fs", base: ".cache/blob" })

    expect(plugin.api.getConfig()).toEqual({
      blob: {
        store: {
          base: ".cache/blob",
          driver: "fs",
        },
      },
    })
  })

  it("lets top-level config override inline plugin options", async () => {
    const plugin = hubBlob({ driver: "fs", base: ".inline/blob" })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      blob: {
        base: ".top-level/blob",
        driver: "fs",
      },
      build: { outDir: "dist" },
      root: process.cwd(),
    } as never)

    expect(plugin.api.getConfig()).toEqual({
      blob: {
        store: {
          base: ".top-level/blob",
          driver: "fs",
        },
      },
    })
  })

  it("exposes resolved config through a stable ViteHub import path", async () => {
    const plugin = hubBlob({ driver: "fs", base: ".virtual/blob" })
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(BLOB_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const blob =")
    expect(code).toContain(".virtual/blob")
  })

  it("registers Nitro runtime setup without Blob serving", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-runtime-"))
    const plugin = hubBlob({ driver: "fs", base: ".runtime/blob" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = {
      nitro: {
        plugins: ["server/plugin.ts"],
      },
    }

    expect(config(userConfig, { command: "build" })).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        plugins: ["server/plugin.ts", ".vitehub/nitro/blob/plugin.ts"],
      },
    })
    const existingPluginConfig = {
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
      },
    }
    expect(config(existingPluginConfig, { command: "build" })).toBeUndefined()
    expect(existingPluginConfig).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
      },
    })
    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    const nitroRuntime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
    expect(nitroPlugin).toContain('"base":".runtime/blob"')
    expect(nitroPlugin).not.toContain("#vitehub/blob/config")
    expect(nitroPlugin).toContain("import './runtime.mjs'")
    expect(nitroPlugin).toContain("setBlobRuntimeConfig(blobConfig)")
    expect(driverImports(nitroRuntime)).toHaveLength(1)
    expect(driverImports(nitroRuntime)[0]).toContain("/drivers/fs")
  })

  it("resolves generated Nitro registrations from the final Vite root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-root-"))
    const staleRoot = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-stale-root-"))
    const plugin = hubBlob({
      bucketName: "assets",
      driver: "cloudflare-r2",
      serve: true,
    }, { nitroOwned: true })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const generatedPlugin = ".vitehub/nitro/blob/plugin.ts"
    const generatedMiddleware = ".vitehub/nitro/blob/middleware.ts"
    const generatedServeHandler = ".vitehub/blob/serve-route.ts"
    const resolvedPlugin = resolve(root, generatedPlugin)
    const resolvedMiddleware = resolve(root, generatedMiddleware)
    const resolvedServeHandler = resolve(root, generatedServeHandler)
    const userConfig: {
      nitro: {
        handlers?: unknown[]
        plugins?: string[]
        preset: string
      }
    } = { nitro: { preset: "cloudflare_module" } }

    config(userConfig, { command: "build" })
    expect(userConfig).toHaveProperty("nitro.plugins", [generatedPlugin])
    expect(userConfig).toHaveProperty("nitro.handlers", [
      { handler: generatedMiddleware, middleware: true, route: "/**" },
      { handler: generatedServeHandler, route: "/api/_vitehub/blob/**" },
    ])

    const resolvedConfig = {
      build: { outDir: "dist" },
      nitro: {
        ...userConfig.nitro,
        handlers: [
          ...(userConfig.nitro.handlers ?? []),
          { handler: resolve(staleRoot, generatedMiddleware), middleware: true, route: "/**" },
          { handler: resolve(staleRoot, generatedServeHandler), route: "/api/_vitehub/blob/**" },
          { handler: resolvedMiddleware, middleware: true, route: "/**" },
          { handler: resolvedServeHandler, route: "/api/_vitehub/blob/**" },
        ],
        plugins: [
          ...(userConfig.nitro.plugins ?? []),
          resolve(staleRoot, generatedPlugin),
          resolvedPlugin,
        ],
      },
      root,
    }

    try {
      await configResolved(resolvedConfig as never)
      await configResolved(resolvedConfig as never)

      expect(root).not.toBe(process.cwd())
      expect(resolvedConfig).toHaveProperty("nitro.plugins", [resolvedPlugin])
      expect(resolvedConfig).toHaveProperty("nitro.handlers", [
        { handler: resolvedMiddleware, middleware: true, route: "/**" },
        { handler: resolvedServeHandler, route: "/api/_vitehub/blob/**" },
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(staleRoot, { force: true, recursive: true })
    }
  })

  it("generates Nitro Blob files from the Nuxt project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nuxt-root-"))
    const appRoot = join(root, "app")
    const generatedPlugin = join(root, ".vitehub", "nitro", "blob", "plugin.ts")
    try {
      await mkdir(appRoot)
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "blob-nuxt-app" }))
      const plugin = hubBlob({ driver: "fs" }, { nitroOwned: true })
      const resolvedConfig = {
        build: { outDir: "dist" },
        nitro: {},
        root: appRoot,
      }

      await (plugin.configResolved as (config: unknown) => void | Promise<void>)(resolvedConfig as never)

      expect(resolvedConfig).toHaveProperty("nitro.plugins", [generatedPlugin])
      expect(existsSync(generatedPlugin)).toBe(true)
      expect(existsSync(join(appRoot, ".vitehub"))).toBe(false)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("runs selected default and named Blob stores from a standalone Node artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-node-"))
    const artifactRoot = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-artifact-"))
    try {
      const plugin = hubBlob({
        stores: {
          archive: { base: ".data/archive", driver: "fs" },
          default: { base: ".data/default", driver: "fs" },
          remote: { driver: "vercel-blob" },
        },
      })
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      await configResolved({ build: { outDir: "dist" }, root } as never)

      const runtimeFile = join(root, ".vitehub", "nitro", "blob", "runtime.mjs")
      const runtimeSource = await readFile(runtimeFile, "utf8")
      expect(driverImports(runtimeSource)).toHaveLength(2)
      expect(driverImports(runtimeSource)[0]).toContain("/drivers/fs")
      expect(runtimeSource).not.toContain("/drivers/netlify-blobs")
      expect(runtimeSource).toContain("/drivers/vercel")
      expect(runtimeSource).toContain("export const blob = createLazyGeneratedBlobStorage(\"default\")")
      expect(runtimeSource).toContain("setNamedBlobRuntimeStorage(name, createLazyGeneratedBlobStorage(name))")

      const entryFile = join(root, "entry.mjs")
      const artifactFile = join(artifactRoot, "server.mjs")
      await writeFile(entryFile, [
        "import './.vitehub/nitro/blob/runtime.mjs'",
        `import { blob } from ${JSON.stringify(join(import.meta.dirname, "../dist/index.js"))}`,
        "const [defaultPutError] = await blob.put('default.txt', 'default-store')",
        "if (defaultPutError) throw defaultPutError",
        "const [archivePutError] = await blob.store('archive').put('archive.txt', 'named-store')",
        "if (archivePutError) throw archivePutError",
        "const [defaultGetError, defaultBlob] = await blob.get('default.txt')",
        "if (defaultGetError) throw defaultGetError",
        "const [archiveGetError, archiveBlob] = await blob.store('archive').get('archive.txt')",
        "if (archiveGetError) throw archiveGetError",
        "const defaultValue = await defaultBlob?.text()",
        "const archiveValue = await archiveBlob?.text()",
        "console.log(JSON.stringify({ archiveValue, defaultValue }))",
        "",
      ].join("\n"), "utf8")
      const buildResult = await bundle({
        bundle: true,
        entryPoints: [entryFile],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outfile: artifactFile,
        platform: "node",
        target: "node24",
      })

      const externalImports = Object.values(buildResult.metafile.outputs)
        .flatMap(output => output.imports)
        .filter(imported => imported.external)
        .map(imported => imported.path)
      expect(externalImports.every(path => path.startsWith("node:"))).toBe(true)
      const { stdout } = await execFileAsync(process.execPath, [artifactFile], { cwd: artifactRoot })
      expect(JSON.parse(stdout)).toEqual({ archiveValue: "named-store", defaultValue: "default-store" })
    }
    finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(artifactRoot, { force: true, recursive: true }),
      ])
    }
  })

  it("does not initialize an unused env-backed default store during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-lazy-default-"))
    const artifactRoot = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-lazy-artifact-"))
    try {
      const plugin = hubBlob({ driver: "vercel-blob" })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({ build: { outDir: "dist" }, root } as never)

      const entryFile = join(root, "entry.mjs")
      const artifactFile = join(artifactRoot, "server.mjs")
      await writeFile(entryFile, [
        "import './.vitehub/nitro/blob/runtime.mjs'",
        "console.log('started')",
        "",
      ].join("\n"), "utf8")
      await bundle({
        bundle: true,
        entryPoints: [entryFile],
        format: "esm",
        logLevel: "silent",
        outfile: artifactFile,
        platform: "node",
        target: "node24",
      })

      const { stdout } = await execFileAsync(process.execPath, [artifactFile], {
        cwd: artifactRoot,
        env: { ...process.env, BLOB_READ_WRITE_TOKEN: undefined },
      })
      expect(stdout.trim()).toBe("started")
    }
    finally {
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(artifactRoot, { force: true, recursive: true }),
      ])
    }
  })

  it("generates only the selected Netlify Blob driver for Nitro", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-netlify-"))
    const artifactRoot = await mkdtemp(join(tmpdir(), "vitehub-blob-netlify-artifact-"))
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.VITEHUB_HOSTING = "netlify"
    try {
      const plugin = hubBlob()
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      await configResolved({ build: { outDir: "dist" }, root } as never)

      const runtimeFile = join(root, ".vitehub", "nitro", "blob", "runtime.mjs")
      const runtimeSource = await readFile(runtimeFile, "utf8")
      expect(driverImports(runtimeSource)).toHaveLength(1)
      expect(driverImports(runtimeSource)[0]).toContain("/drivers/netlify-blobs")
      expect(runtimeSource).not.toContain("/drivers/fs")
      expect(runtimeSource).not.toContain("/drivers/vercel")

      const filesSdkStub = join(root, "files-sdk.mjs")
      const netlifyAdapterStub = join(root, "netlify-blobs.mjs")
      const entryFile = join(root, "entry.mjs")
      const artifactFile = join(artifactRoot, "server.mjs")
      await writeFile(filesSdkStub, [
        "export class Files {",
        "  constructor({ adapter }) {",
        "    if (adapter?.kind !== 'netlify-blobs-adapter-stub') throw new Error('netlify-files-sdk-stub')",
        "    this.adapter = adapter",
        "  }",
        "  async download(key) {",
        "    const value = this.adapter.values.get(key)",
        "    if (!value) throw new Error(`Missing ${key}`)",
        "    return { arrayBuffer: async () => value.bytes.buffer, blob: async () => new Blob([value.bytes], { type: value.contentType }) }",
        "  }",
        "  async upload(key, body, options = {}) {",
        "    const bytes = new Uint8Array(await new Response(body).arrayBuffer())",
        "    this.adapter.values.set(key, { bytes, contentType: options.contentType })",
        "    return { contentType: options.contentType, key, lastModified: new Date(0), size: bytes.byteLength }",
        "  }",
        "  async url(key) { return `https://blob.example/${key}` }",
        "}",
        "",
      ].join("\n"), "utf8")
      await writeFile(netlifyAdapterStub, [
        "export function netlifyBlobs() {",
        "  return { kind: 'netlify-blobs-adapter-stub', values: new Map() }",
        "}",
        "",
      ].join("\n"), "utf8")
      await writeFile(entryFile, [
        "import './.vitehub/nitro/blob/runtime.mjs'",
        `import { blob } from ${JSON.stringify(join(import.meta.dirname, "../dist/index.js"))}`,
        "const [putError] = await blob.put('netlify.txt', 'netlify-store', { contentType: 'text/plain' })",
        "if (putError) throw putError",
        "const [getError, object] = await blob.get('netlify.txt')",
        "if (getError) throw getError",
        "console.log(await object?.text())",
        "",
      ].join("\n"), "utf8")
      const buildResult = await bundle({
        bundle: true,
        entryPoints: [entryFile],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outfile: artifactFile,
        platform: "node",
        plugins: [{
          name: "netlify-sdk-stubs",
          setup(build) {
            build.onResolve({ filter: /^files-sdk$/ }, () => ({ path: filesSdkStub }))
            build.onResolve({ filter: /^files-sdk\/netlify-blobs$/ }, () => ({ path: netlifyAdapterStub }))
          },
        }],
        target: "node24",
      })
      const artifactSource = await readFile(artifactFile, "utf8")
      expect(artifactSource).toContain("netlify-files-sdk-stub")
      expect(artifactSource).toContain("netlify-blobs-adapter-stub")
      expect(artifactSource).not.toContain("files-sdk/vercel-blob")
      expect(artifactSource).not.toContain("files-sdk/s3")
      const externalImports = Object.values(buildResult.metafile.outputs)
        .flatMap(output => output.imports)
        .filter(imported => imported.external)
        .map(imported => imported.path)
      expect(externalImports.every(path => path.startsWith("node:"))).toBe(true)
      const { stdout } = await execFileAsync(process.execPath, [artifactFile], { cwd: artifactRoot })
      expect(stdout.trim()).toBe("netlify-store")
    }
    finally {
      if (typeof previousHosting === "undefined") delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(artifactRoot, { force: true, recursive: true }),
      ])
    }
  })

  it("contributes deduplicated R2 bindings when Nitro owns Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-r2-"))
    const plugin = hubBlob({
      stores: {
        default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
      },
    })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }

    config(userConfig, { command: "build" })
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "ASSETS", bucket_name: "assets" },
    ])
    expect(userConfig).toHaveProperty("nitro.handlers", [{
      handler: ".vitehub/nitro/blob/middleware.ts",
      middleware: true,
      route: "/**",
    }])

    const resolved = {
      blob: {
        stores: {
          default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
          assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
          assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        },
      },
      build: { outDir: "dist" },
      nitro: {
        ...(userConfig as { nitro?: object }).nitro,
        cloudflare: {
          wrangler: {
            compatibility_flags: ["custom"],
            r2_buckets: [{ binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" }],
            routes: ["example.com/*"],
          },
        },
        preset: "cloudflare_module",
      },
      plugins: [{ name: "nitro:main" }],
      root,
    }
    await configResolved(resolved as never)

    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" },
    ])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.routes", ["example.com/*"])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["custom", "nodejs_compat"])
    expect(resolved).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.observability")
  })

  it("lets a facade declare Nitro ownership without a separate Nitro Vite plugin", () => {
    const plugin = hubBlob(
      { bucketName: "vitehub-blob", driver: "cloudflare-r2" },
      { nitroOwned: true },
    )
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const userConfig = { nitro: { preset: "cloudflare-module" } }

    config(userConfig, { command: "build" })

    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "BLOB", bucket_name: "vitehub-blob" },
    ])
  })

  it("uses Cloudflare defaults for the Nitro runtime when hosting is inferred", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-inferred-cloudflare-"))
    const previousBucket = process.env.BLOB_BUCKET_NAME
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.BLOB_BUCKET_NAME = "assets"
    process.env.VITEHUB_HOSTING = "cloudflare"
    try {
      const plugin = hubBlob()
      const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      const value = { nitro: {}, build: { outDir: "dist" }, plugins: [{ name: "nitro:main" }], root }

      config(value, { command: "build" })
      await configResolved(value as never)

      expect(value).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
        { binding: "BLOB", bucket_name: "assets" },
      ])
      const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
      expect(nitroPlugin).toContain('"driver":"cloudflare-r2"')
      expect(nitroPlugin).toContain('"bucketName":"assets"')
      expect(nitroPlugin).toContain("import { env as vitehubEnv } from 'cloudflare:workers'")
      expect(nitroPlugin).toContain("setActiveCloudflareEnv(vitehubEnv)")
      expect(nitroPlugin).not.toContain("hooks.hook('request'")
      const middleware = await readFile(join(root, ".vitehub", "nitro", "blob", "middleware.ts"), "utf8")
      expect(middleware).toContain("defineMiddleware((event) =>")
      expect(middleware).toContain("const target = event as unknown as CloudflareEvent")
      expect(middleware).toContain("setActiveCloudflareEnv(env)")
      expect(middleware).toContain("target.context?._platform?.cloudflare?.env")
      expect(middleware).toContain("target.node?.req?.runtime?.cloudflare?.env ?? (vitehubEnv as unknown as CloudflareEnv)")
      expect(middleware).not.toContain("next")

      await symlink(join(workspaceRoot, "node_modules"), join(root, "node_modules"), "dir")
      await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        files: [".vitehub/nitro/blob/middleware.ts"],
      }, null, 2)}\n`)
      await execFileAsync(process.execPath, [join(workspaceRoot, "node_modules/typescript/bin/tsc"), "-p", root], { cwd: root })
      await writeFile(join(root, "runtime-types.d.ts"), [
        "declare module 'cloudflare:workers' {",
        "  export const env: unknown",
        "}",
        "",
      ].join("\n"))
      await writeFile(join(root, "tsconfig.json"), `${JSON.stringify({
        compilerOptions: {
          module: "Preserve",
          moduleResolution: "Bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          types: [],
        },
        files: ["runtime-types.d.ts", ".vitehub/nitro/blob/middleware.ts"],
      }, null, 2)}\n`)
      await execFileAsync(process.execPath, [join(workspaceRoot, "node_modules/typescript/bin/tsc"), "-p", root], { cwd: root })
    }
    finally {
      if (typeof previousBucket === "undefined") delete process.env.BLOB_BUCKET_NAME
      else process.env.BLOB_BUCKET_NAME = previousBucket
      if (typeof previousHosting === "undefined") delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
    }
  })

  it("uses final Nitro ownership when the resolved preset changes", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-final-nitro-host-"))
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const value = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }

    config(value, { command: "build" })
    const resolved = {
      build: { outDir: "dist/client" },
      nitro: { cloudflare: { wrangler: { routes: ["inactive.example/*"] } }, preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
      root,
    }
    await configResolved(resolved as never)
    await runProviderOutputHooks(plugin)

    expect(existsSync(join(root, "dist", toSafeAppName(root), "index.js"))).toBe(true)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
    const resolvedHandlers = ((resolved as { nitro: { handlers?: { handler: string }[] } }).nitro.handlers) ?? []
    expect(resolvedHandlers).not.toContainEqual(expect.objectContaining({ handler: ".vitehub/nitro/blob/middleware.ts" }))
  })

  it("does not yield Cloudflare output to a non-Cloudflare Nitro host", async () => {
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const value = {
      nitro: { cloudflare: { wrangler: { routes: ["example.com/*"] } }, preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
    }

    config(value, { command: "build" })

    expect(value).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets")
  })

  it("removes an early R2 contribution when the final Nitro host changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-final-nitro-cleanup-"))
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const value = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], root }

    config(value, { command: "build" })
    ;(value.nitro as Record<string, unknown>).preset = "vercel"
    const resolved = { ...value, build: { outDir: "dist" } }
    await configResolved(resolved as never)

    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets.0")
  })

  it("does not contribute Cloudflare config for plain Vite or non-R2 stores", { timeout: 30_000 }, async () => {
    const config = (plugin: ReturnType<typeof hubBlob>, value: Record<string, unknown>) =>
      (plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown)(value, { command: "build" })
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-plain-vite-"))
    const previousPreset = process.env.NITRO_PRESET
    process.env.NITRO_PRESET = "cloudflare_module"
    try {
      const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
      const plainVite = { build: { outDir: "dist" }, root }
      config(plugin, plainVite)
      expect(plainVite).not.toHaveProperty("nitro.cloudflare")
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)(plainVite as never)
      await runProviderOutputHooks(plugin)
      expect(existsSync(join(root, "dist", toSafeAppName(root), "index.js"))).toBe(true)
    }
    finally {
      if (typeof previousPreset === "undefined") delete process.env.NITRO_PRESET
      else process.env.NITRO_PRESET = previousPreset
    }

    const fsOnCloudflare = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }
    config(hubBlob({ base: ".vitehub/data/blob", driver: "fs" }), fsOnCloudflare)
    expect(fsOnCloudflare).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets")
    expect(fsOnCloudflare).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["nodejs_compat"])
  })

  it("masks credentials embedded in Nitro runtime setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-masked-"))
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN
    process.env.BLOB_READ_WRITE_TOKEN = "private-token"

    try {
      const plugin = hubBlob()
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      await configResolved({
        build: { outDir: "dist" },
        root,
      } as never)
    }
    finally {
      if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
      else process.env.BLOB_READ_WRITE_TOKEN = previousToken
    }

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"token":"********"')
    expect(nitroPlugin).not.toContain("private-token")
  })

  it("registers an opt-in Nitro serving route", async () => {
    const plugin = hubBlob({ serve: true })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown

    const userConfig = {}
    expect(config(userConfig, { command: "serve" })).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
        handlers: [{
          handler: ".vitehub/blob/serve-route.ts",
          route: "/api/_vitehub/blob/**",
        }],
      },
    })
  })

  it("writes the generated Nitro serving route handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-serve-route-"))
    const plugin = hubBlob({
      serve: {
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
        route: "/assets",
        store: "media",
      },
      stores: {
        default: {
          driver: "fs",
        },
        media: {
          driver: "fs",
        },
      },
    })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
    expect(handler).toContain("import { defineCachedHandler } from 'nitro/cache'")
    expect(handler).toContain("const storeName = \"media\"")
    expect(handler).toContain("const responseHeaders = {\"Cache-Control\":\"public, max-age=300\",\"X-Content-Type-Options\":\"nosniff\"}")
    expect(handler).toContain("getRouterParam(event, '_', { decode: false })")
    expect(handler).toContain("setResponseHeaders(event, responseHeaders)")
    expect(handler).toContain("blob.store(storeName).serve(event, pathname)")
    expect(handler).toContain("error?.code === 'BLOB_NOT_FOUND'")
    expect(handler).toContain("statusCode: 404")
    expect(handler).toContain("for (const name of Object.keys(responseHeaders)) removeResponseHeader(event, name)")
    expect(handler).toContain("throw error")
    expect(handler).toContain("}, { headersOnly: true, maxAge: 0 })")
    expect(handler.indexOf("setResponseHeaders(event, responseHeaders)")).toBeLessThan(
      handler.indexOf("blob.store(storeName).serve(event, pathname)"),
    )
  })

  it.each([
    {
      expectedCacheControl: "public, max-age=0, s-maxage=0",
      headers: undefined,
      name: "default",
    },
    {
      expectedCacheControl: "private, max-age=60",
      headers: { "Cache-Control": "private, max-age=60" },
      name: "configured",
    },
  ])("preserves non-text bytes with $name cache headers", async ({ expectedCacheControl, headers }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-cached-route-"))
    try {
      const plugin = hubBlob({
        driver: "fs",
        serve: { headers },
      }, { importBase: "virtual:blob-test" })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
        build: { outDir: "dist" },
        root,
      } as never)

      const artifactFile = join(root, "serve-route.mjs")
      await bundle({
        bundle: true,
        entryPoints: [join(root, ".vitehub", "blob", "serve-route.ts")],
        format: "esm",
        logLevel: "silent",
        nodePaths: [join(workspaceRoot, "node_modules")],
        outfile: artifactFile,
        platform: "node",
        plugins: [{
          name: "blob-route-stub",
          setup(build) {
            build.onResolve({ filter: /^virtual:blob-test$/ }, () => ({
              namespace: "blob-route-stub",
              path: "blob",
            }))
            build.onLoad({ filter: /.*/, namespace: "blob-route-stub" }, () => ({
              contents: [
                "export const blob = {",
                "  store(name) {",
                "    if (name !== 'default') throw new Error(`Unexpected store: ${name}`)",
                "    return {",
                "      serve(_event, pathname) {",
                "        if (pathname !== 'binary.bin') throw new Error(`Unexpected pathname: ${pathname}`)",
                "        return [null, new Response(new Uint8Array([0, 128, 255, 195, 40]), {",
                "          headers: { 'Content-Type': 'application/octet-stream' },",
                "        })]",
                "      },",
                "    }",
                "  },",
                "}",
              ].join("\n"),
              loader: "js",
            }))
          },
        }],
        target: "node24",
      })

      const artifact = await import(pathToFileURL(artifactFile).href) as {
        default: (event: H3Event) => Promise<Response>
      }
      const event = new H3Event(new Request("http://localhost/i/binary.bin"))
      event.context.params = { _: "binary.bin" }
      const response = await toResponse(await artifact.default(event), event)

      expect(response.headers.get("Cache-Control")).toBe(expectedCacheControl)
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255, 195, 40]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses a configured package base in physical Nitro imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-import-base-"))
    const plugin = hubBlob({
      driver: "fs",
      serve: true,
    }, { importBase: "vite-hub/_internal/blob" })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    const middleware = await readFile(join(root, ".vitehub", "nitro", "blob", "middleware.ts"), "utf8")
    const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
    expect(nitroPlugin).toContain("from 'vite-hub/_internal/blob/runtime/state'")
    expect(middleware).toContain("from 'vite-hub/_internal/blob/runtime/state'")
    expect(handler).toContain("from 'vite-hub/_internal/blob'")
    expect(`${nitroPlugin}\n${middleware}\n${handler}`).not.toContain("@vite-hub/blob")
  })
})
