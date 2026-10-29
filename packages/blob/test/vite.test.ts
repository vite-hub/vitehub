import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build as bundle } from "esbuild"
import { H3, setResponseHeader } from "h3"
import { afterAll, describe, expect, it, vi } from "vitest"
import { createProviderDeploymentOutputGenerationState, getProviderRuntimeModule, getVercelRuntimePackages, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import { VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

import { BLOB_VIRTUAL_CONFIG_ID, hubBlob } from "../src/vite.ts"

const temporaryDirectories: string[] = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true })))
})

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const execFileAsync = promisify(execFile)
const workspaceRoot = resolve(import.meta.dirname, "../../..")
const nuxtH3 = join(dirname(createRequire(import.meta.resolve("nitropack/package.json")).resolve("h3/package.json")), "dist/index.mjs")

function h3Runtime(nuxt: boolean): import("esbuild").Plugin {
  return {
    name: "test-host-h3",
    setup(build) {
      build.onResolve({ filter: /^h3$/ }, () => ({ path: nuxt ? nuxtH3 : fileURLToPath(import.meta.resolve("h3")) }))
    },
  }
}

async function serveRouteRequest(artifactFile: string, nuxt: boolean, routeBase = "", priorCacheControl?: string) {
  const artifact = await import(pathToFileURL(artifactFile).href) as {
    default: (event: unknown) => Promise<Response>
  }
  if (nuxt) {
    const { createApp, setResponseHeader: setHeader, toWebHandler } = await import(pathToFileURL(nuxtH3).href) as {
      createApp: () => { use: (route: string, handler: (event: { context: { params?: { _: string } }, path: string }) => unknown) => void }
      setResponseHeader: (event: unknown, name: string, value: string) => void
      toWebHandler: (app: unknown) => (request: Request) => Promise<Response>
    }
    const app = createApp()
    app.use("/", (event) => {
      if (priorCacheControl) setHeader(event, "Cache-Control", priorCacheControl)
      event.context.params = { _: event.path.slice(routeBase.length + 1).split("?")[0] }
      return artifact.default(event)
    })
    const fetch = toWebHandler(app)
    return (pathname: string, headers: Record<string, string> = {}, method = "GET") => fetch(new Request(`http://localhost${routeBase}/${pathname}`, { headers, method }))
  }
  const app = new H3()
  app.all("/**", (event) => {
    if (priorCacheControl) setResponseHeader(event, "Cache-Control", priorCacheControl)
    event.context.params = { _: event.url.pathname.slice(routeBase.length + 1) }
    return artifact.default(event)
  })
  return (pathname: string, headers: Record<string, string> = {}, method = "GET") => app.fetch(new Request(`http://localhost${routeBase}/${pathname}`, { headers, method }))
}

function driverImports(source: string) {
  return source.match(/from\s+["'][^"']+\/drivers\/[^"']+["']/g) || []
}

describe("hubBlob", () => {
  it.each([undefined, { authorize: false }, { authorize: true }])("only restarts authorized Blob serving for Auth discovery changes (%j)", async (serve) => {
    const root = await temporaryDirectory("vitehub-blob-auth-watcher-")
    try {
      const plugin = hubBlob({ driver: "fs", serve })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
        build: { outDir: "dist" },
        plugins: [{ name: "@vite-hub/auth/vite", api: { getConfig: () => ({ definitionPath: join(root, "server.auth.ts") }) } }],
        root,
      } as never)
      const listeners = new Map<string, (file: string) => void>()
      const restart = vi.fn()
      const add = vi.fn()
      await (plugin.configureServer as (server: unknown) => void)({
        config: {},
        middlewares: { use: vi.fn() },
        restart,
        watcher: { add, on: (event: string, listener: (file: string) => void) => listeners.set(event, listener) },
      })
      expect(listeners.has("change")).toBe(false)
      for (const event of ["add", "unlink"]) {
        listeners.get(event)?.(join(root, "server.auth.ts"))
        listeners.get(event)?.(join(root, "server", "auth.ts"))
        listeners.get(event)?.(join(root, "server", "other.ts"))
      }
      expect(restart).toHaveBeenCalledTimes(serve?.authorize ? 4 : 0)
      expect(add).toHaveBeenCalledTimes(serve?.authorize ? 1 : 0)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses the bundled driver in the Nitro Vercel shared runtime", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-vercel-runtime-")
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

  it.each([
    ["cloudflare_module", "cloudflare", { binding: "BLOB", bucketName: "assets", driver: "cloudflare-r2" }],
    ["vercel", "vercel", { access: "private", driver: "vercel-blob" }],
  ] as const)("gives sibling %s host functions the Nitro Blob runtime module", async (preset, provider, store) => {
    const root = await temporaryDirectory("vitehub-blob-sibling-runtime-")
    try {
      const plugin = hubBlob(store)
      const resolvedConfig = { build: { outDir: "dist" }, command: "build", nitro: { preset }, plugins: [{ name: "nitro:main" }], root }
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)(resolvedConfig as never)
      const context = { environment: {} }
      const sibling = createProviderDeploymentOutputGenerationState()
      const catalog = useProviderOutputCatalog(resolvedConfig)
      sibling.capture(context, catalog)
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: hubBlob owns this callable Vite lifecycle hook in the focused test.
      ;(plugin.buildStart as unknown as (this: unknown) => void).call(context)

      const generation = sibling.get(context)
      expect(getProviderRuntimeModule(catalog, "blob", provider, generation)).toBe(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"))
      expect(getVercelRuntimePackages(catalog, "blob", generation).map(runtimePackage => runtimePackage.name))
        .toEqual(provider === "vercel" ? ["@vite-hub/blob"] : [])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("gives sibling host functions no Blob runtime for local fs stores", async () => {
    const root = await temporaryDirectory("vitehub-blob-sibling-fs-")
    try {
      const plugin = hubBlob({ driver: "fs" })
      const resolvedConfig = { build: { outDir: "dist" }, command: "build", nitro: { preset: "vercel" }, plugins: [{ name: "nitro:main" }], root }
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)(resolvedConfig as never)
      const context = { environment: {} }
      // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: hubBlob owns this callable Vite lifecycle hook in the focused test.
      ;(plugin.buildStart as unknown as (this: unknown) => void).call(context)

      expect(getProviderRuntimeModule(useProviderOutputCatalog(resolvedConfig), "blob", "vercel")).toBeUndefined()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses the bundled driver when Vercel is detected from the environment", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-vercel-env-runtime-")
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

  it("preserves Nitro inline-all policy", () => {
    const plugin = hubBlob({ driver: "fs", base: ".cache/blob" })
    const config = { nitro: { externals: { inline: true, trace: false } } }
    ;((typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as (config: unknown, env: unknown) => void)(config, { command: "build" })
    expect(config.nitro.externals).toEqual({ inline: true, trace: false })
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
    const root = await temporaryDirectory("vitehub-blob-nitro-runtime-")
    const plugin = hubBlob({ driver: "fs", base: ".runtime/blob" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = {
      nitro: {
        plugins: ["server/plugin.ts"],
      },
    }

    expect(await config(userConfig, { command: "build" })).toBeUndefined()
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
    expect(await config(existingPluginConfig, { command: "build" })).toBeUndefined()
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
    expect(nitroRuntime).toContain('"base": ".runtime/blob"')
    expect(nitroPlugin).not.toContain("#vitehub/blob/config")
    expect(nitroPlugin).toContain("import { blobConfig } from './runtime.mjs'")
    expect(nitroPlugin).toContain("setBlobRuntimeConfig(blobConfig)")
    expect(driverImports(nitroRuntime)).toHaveLength(1)
    expect(driverImports(nitroRuntime)[0]).toContain("/drivers/fs")
  })

  it("resolves generated paths while a framework replays Blob config", () => {
    const root = process.cwd()
    const plugin = hubBlob({ driver: "fs" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const userConfig = {
      [VITEHUB_NITRO_CONFIG_CONTEXT]: true,
      nitro: {},
      root,
    }

    config(userConfig, { command: "build" })

    expect(userConfig.nitro).toMatchObject({
      plugins: [resolve(root, ".vitehub/nitro/blob/plugin.ts")],
    })
  })

  it("resolves generated Nitro registrations from the final Vite root", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-root-")
    const staleRoot = await temporaryDirectory("vitehub-blob-nitro-stale-root-")
    await writeFile(join(root, "package.json"), "{}\n")
    const plugin = hubBlob({
      bucketName: "assets",
      driver: "cloudflare-r2",
      serve: true,
    })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
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
      { handler: generatedMiddleware, middleware: true },
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
        { handler: resolvedMiddleware, middleware: true },
        { handler: resolvedServeHandler, route: "/api/_vitehub/blob/**" },
      ])
    }
    finally {
      await rm(root, { force: true, recursive: true })
      await rm(staleRoot, { force: true, recursive: true })
    }
  })

  it("generates Nitro Blob files from the Nuxt project root", async () => {
    const root = await temporaryDirectory("vitehub-blob-nuxt-root-")
    const appRoot = join(root, "app")
    const generatedPlugin = join(root, ".vitehub", "nitro", "blob", "plugin.ts")
    try {
      await mkdir(appRoot)
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "blob-nuxt-app" }))
      const plugin = hubBlob({ driver: "fs" })
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
    const root = await temporaryDirectory("vitehub-blob-nitro-node-")
    const artifactRoot = await temporaryDirectory("vitehub-blob-nitro-artifact-")
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
    const root = await temporaryDirectory("vitehub-blob-nitro-lazy-default-")
    const artifactRoot = await temporaryDirectory("vitehub-blob-nitro-lazy-artifact-")
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

  it.each(["vercel-blob", "netlify-blobs"] as const)("preserves generated default and named %s stores when Nitro installs its plugin", async (driver) => {
    const root = await temporaryDirectory("vitehub-blob-nitro-replay-")
    try {
      const plugin = hubBlob({ stores: { default: { driver, name: "default" }, assets: { driver, name: "assets" } } })
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
        build: { outDir: "dist" },
        nitro: { preset: driver === "vercel-blob" ? "vercel" : "netlify" },
        plugins: [{ name: "nitro:main" }],
        root,
      } as never)
      const entryFile = join(root, "entry.mjs")
      const artifactFile = join(root, "server.mjs")
      await writeFile(entryFile, [
        "import installBlob from './.vitehub/nitro/blob/plugin.ts'",
        `import { getNamedBlobRuntimeStorage } from ${JSON.stringify(join(import.meta.dirname, "../dist/runtime/state.js"))}`,
        "const stores = ['default', 'assets'].map(name => getNamedBlobRuntimeStorage(name))",
        "installBlob()",
        "installBlob()",
        "for (const [index, name] of ['default', 'assets'].entries()) {",
        "  if (!stores[index] || getNamedBlobRuntimeStorage(name) !== stores[index]) throw new Error(`Lost generated store: ${name}`)",
        "}",
        "console.log('preserved')",
      ].join("\n"))
      await bundle({
        alias: { "@vite-hub/blob/runtime/state": join(import.meta.dirname, "../dist/runtime/state.js") },
        bundle: true,
        entryPoints: [entryFile],
        format: "esm",
        logLevel: "silent",
        outfile: artifactFile,
        platform: "node",
        target: "node24",
      })
      const { stdout } = await execFileAsync(process.execPath, [artifactFile], { cwd: root })
      expect(stdout.trim()).toBe("preserved")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("generates only the selected Netlify Blob driver for Nitro", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-netlify-")
    const artifactRoot = await temporaryDirectory("vitehub-blob-netlify-artifact-")
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

      const entryFile = join(root, "entry.mjs")
      const artifactFile = join(artifactRoot, "server.mjs")
      await writeFile(entryFile, [
        "const values = new Map()",
        "globalThis.fetch = async (input, init = {}) => {",
        "  const url = new URL(input.toString())",
        "  const method = (init.method || 'GET').toUpperCase()",
        "  if (url.hostname === 'api.netlify.com') return Response.json({ url: 'https://signed.blobs.example.test/netlify.txt' })",
        "  if (method === 'PUT') {",
        "    const bytes = await new Response(init.body).arrayBuffer()",
        "    values.set(url.pathname, { bytes, metadata: new Headers(init.headers).get('x-amz-meta-user') })",
        "    return new Response(null, { headers: { etag: 'netlify-etag' }, status: 200 })",
        "  }",
        "  const value = values.get(url.pathname)",
        "  return value",
        "    ? new Response(value.bytes, { headers: { etag: 'netlify-etag', 'x-amz-meta-user': value.metadata } })",
        "    : new Response(null, { status: 404 })",
        "}",
        "const { default: installBlob } = await import('./.vitehub/nitro/blob/plugin.ts')",
        "installBlob()",
        `const { blob } = await import(${JSON.stringify(join(import.meta.dirname, "../dist/index.js"))})`,
        "const [putError] = await blob.put('netlify.txt', 'netlify-store', { contentType: 'text/plain' })",
        "if (putError) throw putError",
        "const [getError, object] = await blob.get('netlify.txt')",
        "if (getError) throw getError",
        "console.log(await object?.text())",
        "",
      ].join("\n"), "utf8")
      const buildResult = await bundle({
        alias: { "@vite-hub/blob/runtime/state": join(import.meta.dirname, "../dist/runtime/state.js") },
        bundle: true,
        entryPoints: [entryFile],
        format: "esm",
        logLevel: "silent",
        metafile: true,
        outfile: artifactFile,
        platform: "node",
        target: "node24",
      })
      const artifactSource = await readFile(artifactFile, "utf8")
      expect(artifactSource).toContain("netlify-etag")
      expect(artifactSource).not.toContain("files-sdk/netlify-blobs")
      expect(artifactSource).not.toContain("files-sdk/vercel-blob")
      expect(artifactSource).not.toContain("files-sdk/s3")
      const externalImports = Object.values(buildResult.metafile.outputs)
        .flatMap(output => output.imports)
        .filter(imported => imported.external)
        .map(imported => imported.path)
      expect(externalImports.every(path => path.startsWith("node:"))).toBe(true)
      const netlifyContext = Buffer.from(JSON.stringify({ siteID: "test-site", token: "test-token" })).toString("base64")
      const { stdout } = await execFileAsync(process.execPath, [artifactFile], {
        cwd: artifactRoot,
        env: { ...process.env, NETLIFY_BLOBS_CONTEXT: netlifyContext },
      })
      expect(stdout.trim()).toBe("netlify-store")
    }
    finally {
      if (previousHosting === undefined) delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
      await Promise.all([
        rm(root, { force: true, recursive: true }),
        rm(artifactRoot, { force: true, recursive: true }),
      ])
    }
  })

  it("contributes deduplicated R2 bindings when Nitro owns Cloudflare output", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-r2-")
    const plugin = hubBlob({
      stores: {
        default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
        assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
        assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
      },
    })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], root }

    config(userConfig, { command: "build" })
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" },
    ])
    expect(userConfig).toHaveProperty("nitro.handlers", [{
      handler: resolve(root, ".vitehub/nitro/blob/middleware.ts"),
      middleware: true,
    }])

    const resolved = {
      blob: {
        stores: {
          default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
          assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
          assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
        },
      },
      build: { outDir: "dist" },
      nitro: {
        ...(userConfig as { nitro?: object }).nitro,
        cloudflare: {
          wrangler: {
            compatibility_flags: ["custom"],
            r2_buckets: [{ binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu", preview_bucket_name: "assets-preview" }],
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
      { binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu", preview_bucket_name: "assets-preview" },
    ])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.routes", ["example.com/*"])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["custom", "nodejs_compat"])
    expect(resolved).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.observability")
  })

  it("contributes R2 bindings from the Cloudflare Nitro preset", () => {
    const plugin = hubBlob({ bucketName: "vitehub-blob", driver: "cloudflare-r2" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const userConfig = { nitro: { preset: "cloudflare-module" } }

    config(userConfig, { command: "build" })

    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "BLOB", bucket_name: "vitehub-blob" },
    ])
  })

  it("passes the R2 jurisdiction to the wrangler binding", () => {
    const plugin = hubBlob({
      stores: {
        default: { bucketName: "eu-assets", driver: "cloudflare-r2", jurisdiction: "eu" },
        archive: { binding: "ARCHIVE", bucketName: "archive", driver: "cloudflare-r2" },
      },
    })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const userConfig = { nitro: { preset: "cloudflare-module" } }

    config(userConfig, { command: "build" })

    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "BLOB", bucket_name: "eu-assets", jurisdiction: "eu" },
      { binding: "ARCHIVE", bucket_name: "archive" },
    ])
    expect(userConfig).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets.1.jurisdiction")
  })

  it("rejects a wrangler R2 binding in another jurisdiction", () => {
    const plugin = hubBlob({ bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const userConfig = {
      nitro: {
        cloudflare: { wrangler: { r2_buckets: [{ binding: "BLOB", bucket_name: "assets" }] } },
        preset: "cloudflare-module",
      },
    }

    expect(() => config(userConfig, { command: "build" })).toThrow("Cloudflare binding \"BLOB\" from blob is already assigned to an incompatible resource.")
  })

  it("bundles Cloudflare middleware with Nuxt's H3 and preserves each host's event bindings", async () => {
    const tempDir = join(workspaceRoot, ".cache/blob-middleware")
    await mkdir(tempDir, { recursive: true })
    const root = await mkdtemp(join(tempDir, "nuxt-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "blob-nuxt-middleware", private: true }))
      const plugin = hubBlob({ driver: "cloudflare-r2", bucketName: "assets" })
      const config: { build: { outDir: string }, nitro: { preset: string, handlers?: Array<{ handler: string, route?: string }> }, root: string } = {
        build: { outDir: "dist" }, nitro: { preset: "cloudflare_module" }, root,
      }
      await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
      const middleware = join(root, ".vitehub/nitro/blob/middleware.ts")
      const nitroEntry = fileURLToPath(import.meta.resolve("nitro"))
      const result = await bundle({
        stdin: {
          contents: `export { default as middleware } from ${JSON.stringify(middleware)}; export { state } from '@vite-hub/blob/runtime/state'`,
          resolveDir: root,
        },
        alias: { nitro: nitroEntry, h3: nuxtH3 },
        bundle: true,
        format: "esm",
        packages: "external",
        platform: "node",
        write: false,
        plugins: [{
          name: "cloudflare-middleware-boundaries",
          setup(build) {
            build.onResolve({ filter: /^(cloudflare:workers|@vite-hub\/blob\/runtime\/state)$/ }, args => ({ path: args.path, namespace: "middleware-test" }))
            build.onLoad({ filter: /.*/, namespace: "middleware-test" }, args => ({
              contents: args.path === "cloudflare:workers"
                ? 'export const env = { source: "module" }'
                : 'export const state = {}; export function setActiveCloudflareEnv(env) { state.env = env }',
            }))
            // Isolate Nitro's public entry and its H3 contract from unrelated runtime internals.
            build.onResolve({ filter: /^\./ }, args => args.importer === nitroEntry ? { path: args.path, external: true } : undefined)
          },
        }],
      })
      const { middleware: handle, state } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`) as {
        middleware: (event: unknown) => void
        state: { env: unknown }
      }
      const env = { source: "request" }
      for (const event of [
        { env },
        { context: { cloudflare: { env } } },
        { context: { _platform: { cloudflare: { env } } } },
        { req: { runtime: { cloudflare: { env } } } },
        { node: { req: { runtime: { cloudflare: { env } } } } },
      ]) {
        expect(handle(event)).toBeUndefined()
        expect(state.env).toBe(env)
      }
      handle({})
      expect(state.env).toEqual({ source: "module" })

      const { createApp, toWebHandler } = await import(pathToFileURL(nuxtH3).href) as {
        createApp: () => { use: (route: string, handler: (event: unknown) => unknown) => void }
        toWebHandler: (app: unknown) => (request: Request) => Promise<Response>
      }
      const app = createApp()
      app.use("/", (event) => { Object.assign(event as object, { context: { cloudflare: { env } } }) })
      const registration = config.nitro.handlers?.find(handler => handler.handler === middleware)
      expect(registration).toBeDefined()
      app.use(registration!.route || "/", handle)
      app.use("/ordinary-route", () => state.env)
      const response = await toWebHandler(app)(new Request("http://localhost/ordinary-route"))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(env)
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses Cloudflare defaults for the Nitro runtime when hosting is inferred", { timeout: 30_000 }, async () => {
    const root = await temporaryDirectory("vitehub-blob-inferred-cloudflare-")
    const previousBucket = process.env.BLOB_BUCKET_NAME
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.BLOB_BUCKET_NAME = "assets"
    process.env.VITEHUB_HOSTING = "cloudflare"
    try {
      const plugin = hubBlob()
      const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
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
      expect(middleware).toContain("export default function vitehubBlobMiddleware(event: unknown)")
      expect(middleware).not.toContain("from 'nitro'")
      expect(middleware).toContain("const target = event as CloudflareEvent")
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

  it("does not import cloudflare:workers in vite dev, where the Nitro dev runner can be Node", async () => {
    const root = await temporaryDirectory("vitehub-blob-cloudflare-dev-")
    try {
      const plugin = hubBlob({ bucketName: "assets", driver: "cloudflare-r2" })
      const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      const value = { nitro: { preset: "cloudflare-module" }, build: { outDir: "dist" }, plugins: [{ name: "nitro:main" }], root }

      config(value, { command: "serve" })
      // The Nuxt replay passes the resolved config without `command`.
      await configResolved(value as never)

      const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
      const middleware = await readFile(join(root, ".vitehub", "nitro", "blob", "middleware.ts"), "utf8")
      expect(nitroPlugin).not.toContain("cloudflare:workers")
      expect(nitroPlugin).toContain('"driver":"cloudflare-r2"')
      expect(middleware).not.toContain("cloudflare:workers")
      expect(middleware).toContain("target.req?.runtime?.cloudflare?.env")
      expect(middleware).toContain("if (env) setActiveCloudflareEnv(env)")
      expect(value).toHaveProperty("nitro.handlers", expect.arrayContaining([
        expect.objectContaining({ handler: resolve(root, ".vitehub/nitro/blob/middleware.ts"), middleware: true }),
      ]))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("uses final Nitro ownership when the resolved preset changes", { timeout: 30_000 }, async () => {
    const root = await temporaryDirectory("vitehub-blob-final-nitro-host-")
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
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

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
    const resolvedHandlers = ((resolved as { nitro: { handlers?: { handler: string }[] } }).nitro.handlers) ?? []
    expect(resolvedHandlers).not.toContainEqual(expect.objectContaining({ handler: ".vitehub/nitro/blob/middleware.ts" }))
  })

  it("does not yield Cloudflare output to a non-Cloudflare Nitro host", async () => {
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const value = {
      nitro: { cloudflare: { wrangler: { routes: ["example.com/*"] } }, preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
    }

    config(value, { command: "build" })

    expect(value).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets")
  })

  it("removes an early R2 contribution when the final Nitro host changes", async () => {
    const root = await temporaryDirectory("vitehub-blob-final-nitro-cleanup-")
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const value = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], root }

    config(value, { command: "build" })
    ;(value.nitro as Record<string, unknown>).preset = "vercel"
    const resolved = { ...value, build: { outDir: "dist" } }
    await configResolved(resolved as never)

    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets.0")
  })

  it("does not contribute R2 bindings for non-R2 stores", () => {
    const config = (plugin: ReturnType<typeof hubBlob>, value: Record<string, unknown>) =>
      ((typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown)(value, { command: "build" })
    const fsOnCloudflare = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }
    config(hubBlob({ base: ".vitehub/data/blob", driver: "fs" }), fsOnCloudflare)
    expect(fsOnCloudflare).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets")
    expect(fsOnCloudflare).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["nodejs_compat"])
  })

  it("masks credentials embedded in Nitro runtime setup", async () => {
    const root = await temporaryDirectory("vitehub-blob-nitro-masked-")
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
    expect(nitroPlugin).toContain("import { blobConfig } from './runtime.mjs'")
    expect(nitroPlugin).not.toContain("private-token")
    const runtime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
    expect(runtime).toContain('"token": "********"')
    expect(runtime).not.toContain("private-token")
  })

  it("registers an opt-in Nitro serving route", async () => {
    const plugin = hubBlob({ serve: true })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown

    const userConfig = {}
    expect(await config(userConfig, { command: "serve" })).toBeUndefined()
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
    const root = await temporaryDirectory("vitehub-blob-serve-route-")
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
    expect(handler).not.toContain("from 'nitro/cache'")
    expect(handler).toContain("const storeName = \"media\"")
    expect(handler).toContain("const responseHeaders = {\"Cache-Control\":\"public, max-age=300\",\"X-Content-Type-Options\":\"nosniff\"}")
    expect(handler).toContain("getRouterParam(event, '_', { decode: false })")
    expect(handler).toContain("setResponseHeaders(event, responseHeaders)")
    expect(handler).toContain("blob.store(storeName).serve(event, pathname, options)")
    expect(handler).toContain("error?.code === 'BLOB_NOT_FOUND'")
    expect(handler).toContain("statusCode: 404")
    expect(handler).toContain("for (const name of Object.keys(responseHeaders)) removeResponseHeader(event, name)")
    expect(handler).toContain("throw error")
    expect(handler).toContain("defineEventHandler(serveBlob)")
    expect(handler.indexOf("setResponseHeaders(event, responseHeaders)")).toBeLessThan(
      handler.indexOf("blob.store(storeName).serve(event, pathname, options)"),
    )
  })

  const serveCacheCases: Array<{ expectedCacheControl: string, headers: Record<string, string> | undefined, name: string }> = [
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
    {
      expectedCacheControl: "private, max-age=60",
      headers: { "cache-control": "private, max-age=60" },
      name: "lowercase configured",
    },
    {
      expectedCacheControl: "public, max-age=300",
      headers: { "Cache-Control": "private, max-age=60", "cache-control": "public, max-age=300" },
      name: "duplicate lowercase last",
    },
    {
      expectedCacheControl: "private, max-age=60",
      headers: { "cache-control": "public, max-age=300", "Cache-Control": "private, max-age=60" },
      name: "duplicate canonical last",
    },
  ]
  it.each(serveCacheCases.flatMap(config => [false, true].map(nuxt => ({ ...config, nuxt }))))("preserves non-text bytes with $name cache headers (Nuxt: $nuxt)", async ({ expectedCacheControl, headers, nuxt }) => {
    const root = await temporaryDirectory("vitehub-blob-cached-route-")
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
        plugins: [h3Runtime(nuxt), {
          name: "blob-route-stub",
          setup(build) {
            build.onResolve({ filter: /^virtual:blob-test$/ }, () => ({
              namespace: "blob-route-stub",
              path: "blob",
            }))
            build.onLoad({ filter: /.*/, namespace: "blob-route-stub" }, () => ({
              contents: [
                `import { createBlobStorage } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/storage.ts"))}`,
                `export { parseImageVariant } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/media/variant.ts"))}`,
                "const storage = createBlobStorage({",
                "  name: 'blob-route-test',",
                "  async head(pathname) {",
                "    if (pathname === 'missing.bin') return null",
                "    return { pathname, contentType: 'application/octet-stream', size: 5, httpEtag: '\"binary-v1\"', uploadedAt: new Date(0), httpMetadata: {}, customMetadata: {} }",
                "  },",
                "  async get() { return new Blob([new Uint8Array([0, 128, 255, 195, 40])], { type: 'application/octet-stream' }) },",
                "})",
                "export const blob = { store(name) {",
                "  if (name !== 'default') throw new Error(`Unexpected store: ${name}`)",
                "  return storage",
                "} }",
              ].join("\n"),
              resolveDir: workspaceRoot,
              loader: "js",
            }))
          },
        }],
        target: "node24",
      })

      const request = await serveRouteRequest(artifactFile, nuxt)
      const response = await request("binary.bin")

      expect(response.headers.get("Cache-Control")).toBe(expectedCacheControl)
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream")
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255, 195, 40]))
      const etag = response.headers.get("etag")!
      expect(etag).toBeTruthy()
      const notModified = await request("binary.bin", { "If-None-Match": etag })

      expect(notModified.status).toBe(304)
      expect(notModified.headers.get("Cache-Control")).toBe(expectedCacheControl)
      expect(notModified.headers.get("Content-Length")).toBeNull()
      expect(await notModified.text()).toBe("")

      const conditions: Array<Record<string, string>> = [
        { "If-None-Match": `"other,tag", W/${etag}` },
        { "If-None-Match": "*" },
      ]
      for (const condition of conditions) {
        expect((await request("binary.bin", condition)).status).toBe(304)
      }
      const changed = await request("binary.bin", { "If-None-Match": '"older"' })
      expect(changed.status).toBe(200)
      expect(new Uint8Array(await changed.arrayBuffer())).toEqual(new Uint8Array([0, 128, 255, 195, 40]))
      const head = await request("binary.bin", {}, "HEAD")
      expect(head.status).toBe(200)
      expect(head.headers.get("Content-Length")).toBe("5")
      expect(await head.text()).toBe("")
      const partial = await request("binary.bin", { Range: "bytes=1-2" })
      expect(partial.status).toBe(206)
      expect(partial.headers.get("Content-Range")).toBe("bytes 1-2/5")
      expect(new Uint8Array(await partial.arrayBuffer())).toEqual(new Uint8Array([128, 255]))
      const invalidRange = await request("binary.bin", { Range: "bytes=99-" })
      expect(invalidRange.status).toBe(416)
      expect(await invalidRange.text()).toBe("")
      const invalidVariant = await request("binary.bin?w=invalid")
      expect(invalidVariant.status).toBe(400)
      const missing = await request("missing.bin", { "If-None-Match": "*" })
      expect(missing.status).toBe(404)
      expect(missing.headers.get("Cache-Control")).toBeNull()
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  describe.each([false, true])("serve authorization (Nuxt: %s)", (nuxt) => {
    const authPlugin = { name: "@vite-hub/auth/vite", api: { getConfig: () => ({ definition: {} }) } }

    async function bundleServeRoute(root: string, priorCacheControl?: string) {
      const artifactFile = join(root, "serve-route.mjs")
      await bundle({
        bundle: true,
        entryPoints: [join(root, ".vitehub", "blob", "serve-route.ts")],
        format: "esm",
        logLevel: "silent",
        nodePaths: [join(workspaceRoot, "node_modules")],
        outfile: artifactFile,
        platform: "node",
        plugins: [h3Runtime(nuxt), {
          name: "blob-authorize-route-stub",
          setup(build) {
            build.onResolve({ filter: /^virtual:blob-test$/ }, args => ({
              namespace: "blob-authorize-route-stub",
              path: args.path,
            }))
            build.onLoad({ filter: /^virtual:blob-test$/, namespace: "blob-authorize-route-stub" }, () => ({
              contents: [
                `import { createBlobStorage } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/storage.ts"))}`,
                "export const parseImageVariant = () => undefined",
                "const storage = createBlobStorage({",
                "  name: 'blob-auth-test',",
                "  async head(pathname) { return { pathname, contentType: 'image/jpeg', size: 3, httpEtag: '\"photo-v1\"', uploadedAt: new Date(0), httpMetadata: {}, customMetadata: {} } },",
                "  async get() { return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) },",
                "})",
                "export const blob = { store() { return {",
                "  serve(event, pathname, options) {",
                "    globalThis.__vitehubBlobServeCalls.push(pathname)",
                "    return storage.serve(event, pathname, options)",
                "  },",
                "} } }",
              ].join("\n"),
              resolveDir: workspaceRoot,
              loader: "js",
            }))
            build.onResolve({ filter: /^#vitehub\/auth\/server$/ }, () => ({
              path: join(workspaceRoot, "packages/auth/src/server.ts"),
            }))
            build.onResolve({ filter: /^(?:better-auth|#vitehub\/auth\/definition)$/ }, (args) => {
              if (args.path === "better-auth" && args.importer !== join(workspaceRoot, "packages/auth/src/server.ts")) return
              return { namespace: "auth-provider-test", path: args.path }
            })
            build.onLoad({ filter: /^#vitehub\/auth\/definition$/, namespace: "auth-provider-test" }, () => ({
              contents: `import { defineAuth } from ${JSON.stringify(join(workspaceRoot, "packages/auth/src/index.ts"))}; export default defineAuth({ appName: "Blob test" })`,
              loader: "js",
              resolveDir: workspaceRoot,
            }))
            // Keep the real Auth guard and origin resolution; replace only the session provider.
            build.onLoad({ filter: /^better-auth$/, namespace: "auth-provider-test" }, () => ({
              contents: [
                "export function betterAuth() {",
                "  return { api: { getSession({ headers }) {",
                "    const cookie = headers.get('cookie') || ''",
                "    if (!cookie.startsWith('session=')) return null",
                "    const id = cookie.slice(8)",
                "    return { user: { id }, session: { id: 'blob-session', userId: id } }",
                "  } } }",
                "}",
              ].join("\n"),
              loader: "js",
            }))
          },
        }],
        target: "node24",
      })
      return await serveRouteRequest(artifactFile, nuxt, "/photos", priorCacheControl)
    }

    it("requires a session before the store read and before conditional handling", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-session-")
      const calls: string[] = []
      Reflect.set(globalThis, "__vitehubBlobServeCalls", calls)
      try {
        const plugin = hubBlob({ driver: "fs", serve: { authorize: true, route: "/photos" } }, { importBase: "virtual:blob-test" })
        await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [authPlugin],
          root,
        } as never)
        const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
        expect(handler).toContain("import { withAuthorization } from \"#vitehub/auth/server\"")
        expect(handler).toContain("withAuthorization(true, (event: H3Event) => serveBlob(event))")

        const request = await bundleServeRoute(root, "public, max-age=3600")
        const anonymous = await request("u1/meal.jpg")
        expect(anonymous.status).toBe(401)
        const conditionalAnonymous = await request("u1/meal.jpg", { "If-None-Match": '"photo-v1"' })
        expect(conditionalAnonymous.status).toBe(401)
        expect(calls).toEqual([])

        const signedIn = await request("u1/meal.jpg", { cookie: "session=u1" })
        expect(signedIn.status).toBe(200)
        expect(signedIn.headers.get("Cache-Control")).toBe("private, no-cache")
        expect(new Uint8Array(await signedIn.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
        const conditional = await request("u1/meal.jpg", { "cookie": "session=u1", "If-None-Match": signedIn.headers.get("etag")! })
        expect(conditional.status).toBe(304)
        expect(calls).toEqual(["u1/meal.jpg", "u1/meal.jpg"])
      }
      finally {
        Reflect.deleteProperty(globalThis, "__vitehubBlobServeCalls")
        await rm(root, { force: true, recursive: true })
      }
    })

    it.each([
      { extension: ".ts", policy: "export const authorize = ({ request, user }) => new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)" },
      ...[".cts", ".cjs"].flatMap(extension => {
        const callback = extension === ".cts"
          ? "({ request, user }: { request: Request, user: { id: string } }) => new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)"
          : "({ request, user }) => new URL(request.url).pathname.startsWith(`/photos/${user.id}/`)"
        return [
          { extension, policy: `exports.authorize = ${callback}` },
          { extension, policy: `exports["authorize"] = ${callback}` },
          { extension, policy: `Object.defineProperty(exports, "authorize", { enumerable: true, value: ${callback} })` },
        ]
      }),
    ])("runs the authorize export from server/blob$extension: $policy", async ({ extension, policy }) => {
      const root = await temporaryDirectory("vitehub-blob-authorize-module-")
      const calls: string[] = []
      Reflect.set(globalThis, "__vitehubBlobServeCalls", calls)
      try {
        await mkdir(join(root, "server"), { recursive: true })
        await writeFile(join(root, "server", `blob${extension}`), `${policy}\n`)
        const plugin = hubBlob({
          driver: "fs",
          serve: { authorize: true, headers: { "Cache-Control": "private, max-age=60" }, route: "/photos" },
        }, { importBase: "virtual:blob-test" })
        await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [[authPlugin]],
          root,
        } as never)
        const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
        expect(handler).toContain(`import { authorize } from ${JSON.stringify(join(root, "server", `blob${extension}`))}`)
        expect(handler).toContain("withAuthorization(authorize, (event: H3Event) => serveBlob(event))")

        const request = await bundleServeRoute(root)
        const own = await request("u1/meal.jpg", { cookie: "session=u1" })
        expect(own.status).toBe(200)
        expect(own.headers.get("Cache-Control")).toBe("private, max-age=60")
        const other = await request("u2/meal.jpg", { cookie: "session=u1" })
        expect(other.status).toBe(403)
        expect(calls).toEqual(["u1/meal.jpg"])
      }
      finally {
        Reflect.deleteProperty(globalThis, "__vitehubBlobServeCalls")
        await rm(root, { force: true, recursive: true })
      }
    })

    it("fails the build when serve authorization has no Auth Definition", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-no-auth-")
      try {
        for (const plugins of [[], [{ name: "@vite-hub/auth/vite", api: { getConfig: () => undefined } }]]) {
          const plugin = hubBlob({ driver: "fs", serve: { authorize: true } })
          await expect((plugin.configResolved as (config: unknown) => void | Promise<void>)({
            build: { outDir: "dist" },
            plugins,
            root,
          } as never)).rejects.toThrow("`blob.serve.authorize` requires an Auth Definition.")
        }
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    })

    it("fails the build when server/blob.ts exports authorize without serve authorization", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-disabled-")
      try {
        await mkdir(join(root, "server"), { recursive: true })
        await writeFile(join(root, "server", "blob.ts"), "export const authorize = () => true\n")
        const plugin = hubBlob({ driver: "fs", serve: { route: "/photos" } })
        await expect((plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [authPlugin],
          root,
        } as never)).rejects.toThrow("but `blob.serve.authorize` is not true")
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    })

    it("does not scan the default server directory when the host selects none", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-empty-server-dirs-")
      try {
        await mkdir(join(root, "server"), { recursive: true })
        await writeFile(join(root, "server", "blob.ts"), "export const authorize = () => true\n")
        const plugin = hubBlob({ driver: "fs", serve: { authorize: true } })
        await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [authPlugin],
          root,
          [VITEHUB_SERVER_DIRS]: [],
        } as never)
        const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
        expect(handler).not.toContain(JSON.stringify(join(root, "server", "blob.ts")))
        expect(handler).toContain("withAuthorization(true, (event: H3Event) => serveBlob(event))")
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  })

  it("uses a configured package base in physical Nitro imports", async () => {
    const root = await temporaryDirectory("vitehub-blob-import-base-")
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
