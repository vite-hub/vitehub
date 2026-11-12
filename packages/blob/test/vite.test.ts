import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

import { build as bundle } from "esbuild"
import { installStandardContext } from "@vite-hub/runtime/h3"
import { H3, setResponseHeader } from "h3"
import { afterAll, describe, expect, it, vi } from "vitest"
import { resolveConfig as resolveViteConfig } from "vite"
import { createProviderDeploymentOutputGenerationState, getProviderRuntimeModule, getVercelRuntimePackages, useProviderOutputCatalog } from "@vite-hub/internal/build/deployment-output"
import type { UserConfig } from "vite"
import { VITEHUB_DEPLOYMENT_PRESET, VITEHUB_FEATURES, VITEHUB_NITRO_CONFIG_CONTEXT, VITEHUB_PREPARE, VITEHUB_SERVER_DIRS } from "@vite-hub/internal/build/vite"

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
/** Mount the generated Fetchable route like Nitro: Standard Context first, then middleware, then the route. */
async function serveRouteRequest(artifactFile: string, routeBase = "", priorCacheControl?: string, baseURL = "", requestBase = routeBase) {
  routeBase = routeBase.replace(/\/+$/, "").replace(/\[([^\]]+)\]/g, ":$1")
  requestBase = requestBase.replace(/\/+$/, "")
  const artifact = await import(pathToFileURL(artifactFile).href) as {
    default: { fetch: (request: Request) => Promise<Response> }
  }
  const app = new H3({ onRequest: event => installStandardContext(event) })
  app.use((event) => {
    if (priorCacheControl) setResponseHeader(event, "Cache-Control", priorCacheControl)
    event.res.headers.append("set-cookie", "a=1; Path=/")
    event.res.headers.append("set-cookie", "b=2; Path=/")
    event.res.headers.set("x-middleware", "yes")
  })
  app.all(`${baseURL}${routeBase}/**`, artifact.default)
  return (pathname: string, headers: Record<string, string> = {}, method = "GET") => app.fetch(new Request(`http://localhost${baseURL}${requestBase}/${pathname}`, { headers, method }))
}

function driverImports(source: string) {
  return source.match(/from\s+["'][^"']+\/drivers\/[^"']+["']/g) || []
}

describe("hubBlob", () => {
  it("imports without the optional Vite peer", async () => {
    const script = [
      'import { registerHooks } from "node:module"',
      'registerHooks({ resolve(specifier, context, nextResolve) {',
      '  if (specifier === "vite" || specifier.startsWith("vite/")) {',
      '    throw Object.assign(new Error("Cannot find package vite"), { code: "ERR_MODULE_NOT_FOUND" })',
      '  }',
      '  return nextResolve(specifier, context)',
      '} })',
      'const { hubBlob } = await import("@vite-hub/blob/vite")',
      'console.log(typeof hubBlob)',
    ].join("\n")
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: resolve(import.meta.dirname, ".."),
    })
    expect(stdout.trim()).toBe("function")
  })

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
      [VITEHUB_FEATURES]: { blob: {
        base: ".top-level/blob",
        driver: "fs",
      } },
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
    const resolveId = plugin.resolveId as { filter: { id: RegExp }, handler: (id: string) => string | undefined }
    const load = plugin.load as { filter: { id: RegExp }, handler: (id: string) => string | undefined }
    const resolvedId = resolveId.handler(BLOB_VIRTUAL_CONFIG_ID)
    const code = load.handler(resolvedId!)

    expect([BLOB_VIRTUAL_CONFIG_ID, "#vitehub/blob/config.ts", "@vite-hub/blob"].map(id => resolveId.filter.id.test(id))).toEqual([true, false, false])
    expect([resolvedId!, BLOB_VIRTUAL_CONFIG_ID].map(id => load.filter.id.test(id))).toEqual([true, false])

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
      const store = (name: string) => driver === "netlify-blobs" ? { driver, name } : { driver }
      const plugin = hubBlob({ stores: { default: store("default"), assets: store("assets") } })
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
      [VITEHUB_FEATURES]: { blob: {
        stores: {
          default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
          assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
          assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2", jurisdiction: "eu" },
        },
      } },
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

  it("bundles Cloudflare middleware and reads Standard Context bindings on H3 requests", async () => {
    const tempDir = join(workspaceRoot, ".cache/blob-middleware")
    await mkdir(tempDir, { recursive: true })
    const root = await mkdtemp(join(tempDir, "nitro-"))
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ name: "blob-nitro-middleware", private: true }))
      const plugin = hubBlob({ driver: "cloudflare-r2", bucketName: "assets" })
      const config: { build: { outDir: string }, nitro: { preset: string, handlers?: Array<{ handler: string, route?: string }> }, root: string } = {
        build: { outDir: "dist" }, nitro: { preset: "cloudflare_module" }, root,
      }
      await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
      const middleware = join(root, ".vitehub/nitro/blob/middleware.ts")
      const nitroEntry = fileURLToPath(import.meta.resolve("nitro"))
      // The generated middleware imports the Blob runtime state by file path.
      const runtimeState = join(import.meta.dirname, "../dist/runtime/state.js")
      const result = await bundle({
        stdin: {
          contents: `export { default as middleware } from ${JSON.stringify(middleware)}; export { state } from ${JSON.stringify(runtimeState)}`,
          resolveDir: root,
        },
        alias: { nitro: nitroEntry, h3: fileURLToPath(import.meta.resolve("h3")) },
        bundle: true,
        format: "esm",
        packages: "external",
        platform: "node",
        write: false,
        plugins: [{
          name: "cloudflare-middleware-boundaries",
          setup(build) {
            build.onResolve({ filter: /^cloudflare:workers$/ }, args => ({ path: args.path, namespace: "middleware-test" }))
            build.onResolve({ filter: /runtime[\\/]state\.js$/ }, args => args.path === runtimeState ? { path: "runtime-state", namespace: "middleware-test" } : undefined)
            build.onLoad({ filter: /.*/, namespace: "middleware-test" }, args => ({
              resolveDir: root,
              contents: args.path === "cloudflare:workers"
                ? 'export const env = { source: "module" }'
                : 'export const state = {}; export function setActiveCloudflareEnv(env) { state.env = env }; export function getRequestCloudflareEnv(event) { return event["~standard"].runtime?.cloudflare?.env }',
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
      expect(handle({ "~standard": { runtime: { cloudflare: { env } } } })).toBeUndefined()
      expect(state.env).toBe(env)
      handle({ "~standard": { runtime: {} } })
      expect(state.env).toEqual({ source: "module" })

      const registration = config.nitro.handlers?.find(handler => handler.handler === middleware)
      expect(registration).toBeDefined()
      const app = new H3({
        onRequest(event) {
          event.context.cloudflare = { env }
          // The ViteHub Nitro plugin sets Standard Context in the `request` hook, before middleware.
          installStandardContext(event)
          handle(event)
        },
      }).get("/ordinary-route", () => state.env)
      const response = await app.fetch(new Request("http://localhost/ordinary-route"))
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
      expect(middleware).toContain("export default function vitehubBlobMiddleware(event: Parameters<typeof getRequestCloudflareEnv>[0])")
      expect(middleware).not.toContain("from 'nitro'")
      expect(middleware).toContain("setActiveCloudflareEnv(env)")
      expect(middleware).toContain("getRequestCloudflareEnv(event) ?? (vitehubEnv as unknown as Record<string, unknown>)")
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
      expect(middleware).toContain("const env = getRequestCloudflareEnv(event)")
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
        handlers: [
          { handler: expect.stringMatching(/runtime[/\\]signed\.(?:js|ts)$/), route: "/_vitehub/blob/signed/**" },
          { handler: ".vitehub/blob/serve-route.ts", route: "/api/_vitehub/blob/**" },
        ],
      },
    })
  })

  it("registers the signed route only when a store uses the fs driver", async () => {
    async function handlers(options: Parameters<typeof hubBlob>[0]) {
      const plugin = hubBlob(options)
      const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
      const userConfig: { nitro?: { handlers?: unknown[] } } = {}
      await config(userConfig, { command: "build" })
      return userConfig.nitro?.handlers
    }
    const signed = { handler: expect.stringMatching(/runtime[/\\]signed\.(?:js|ts)$/), route: "/_vitehub/blob/signed/**" }

    expect(await handlers({ driver: "fs" })).toEqual([signed])
    expect(await handlers({ stores: { default: { bucketName: "assets", driver: "cloudflare-r2" }, local: { driver: "fs" } } })).toEqual([signed])
    expect(await handlers({ bucketName: "assets", driver: "cloudflare-r2" })).toEqual([])
    expect(await handlers({ bucket: "assets", driver: "s3" })).toEqual([])
  })

  it.each([
    ["serve", 1],
    ["build", 0],
  ] as const)("registers the signed route once for the local fallback of R2 in %s", async (command, count) => {
    // The `config` hook and `configResolved` both resolve the dev store. The route stays registered once.
    const plugin = hubBlob()
    const configHook = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const config: Record<string, unknown> & { nitro: { handlers?: Array<{ route?: string }>, preset: string } } = {
      build: { outDir: "dist" },
      command,
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      root: await temporaryDirectory("vitehub-blob-signed-route-"),
    }
    await configHook(config, { command })
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config)
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config)

    expect(config.nitro.handlers?.filter(handler => handler.route === "/_vitehub/blob/signed/**")).toHaveLength(count)
  })

  it.each([
    ["the local store of an inferred Vercel Blob store", "serve", { BLOB_READ_WRITE_TOKEN: "secret-token" }, {}, 1],
    ["the local fallback of R2", "serve", {}, { preset: "cloudflare_module" }, 1],
    ["a hosted Vercel Blob store", "build", { BLOB_READ_WRITE_TOKEN: "secret-token" }, {}, 0],
  ] as const)("registers the signed route in the Nitro instance for %s in %s", async (_name, command, env, nitroConfig, count) => {
    // Nitro copies its handlers in its own `config` hook. A later change to the Vite config does not reach its router.
    const { nitro }: { nitro: () => unknown } = await import("nitro/vite" as string)
    const root = await temporaryDirectory("vitehub-blob-signed-nitro-")
    await writeFile(join(root, "package.json"), "{}")
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
    let handlers: Array<{ route?: string }> | undefined
    let close: (() => Promise<void>) | undefined
    try {
      await resolveViteConfig({
        configFile: false,
        logLevel: "silent",
        nitro: nitroConfig,
        plugins: [
          hubBlob({ images: false }),
          nitro() as never,
          { name: "capture-nitro", nitro: { setup(instance: { close: () => Promise<void>, options: { handlers: Array<{ route?: string }> } }) {
            handlers = instance.options.handlers
            close = () => instance.close()
          } } } as never,
        ],
        root,
      } as UserConfig, command)

      expect(handlers?.filter(handler => handler.route === "/_vitehub/blob/signed/**")).toHaveLength(count)
    }
    finally {
      await close?.()
      vi.unstubAllEnvs()
    }
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
    expect(handler).toContain("headers: {\"Cache-Control\":\"public, max-age=300\",\"X-Content-Type-Options\":\"nosniff\"}")
    expect(handler).not.toMatch(/from ['"]h3['"]/)
    expect(handler).not.toContain("node.res")
    expect(handler).toContain("blob.store(storeName).serve(request, pathname, options)")
    expect(handler).toContain("const routeSegments: string[] = [\"assets\"]")
    expect(handler).toContain("export default { fetch: serveBlob }")
  })

  const serveCacheCases: Array<{ baseURL?: string, expectedCacheControl: string, headers?: Record<string, string>, name: string, requestRoute?: string, route?: string }> = [
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
    ...[
      { name: "root route behind a base URL", route: "/", baseURL: "/app" },
      { name: "route repeated in the base URL", route: "/assets", baseURL: "/assets" },
      { name: "overlapping route segments", route: "/api/files", baseURL: "/api/files/api" },
      { name: "literal space in the route", route: "/my files", baseURL: "/app" },
      { name: "encoded space in the route", route: "/my%20files", baseURL: "/app" },
      { name: "parameterized route", route: "/files/:tenant", baseURL: "/files/acme", requestRoute: "/files/acme" },
      { name: "bracket parameter route", route: "/files/[tenant]", baseURL: "/files/acme", requestRoute: "/files/acme" },
    ].map(test => ({ ...test, expectedCacheControl: "public, max-age=0, s-maxage=0" })),
  ]
  it.each(serveCacheCases)("preserves the Blob path and response with $name", async ({ expectedCacheControl, headers, route: serveRoute = "/api/_vitehub/blob", baseURL = "", requestRoute = serveRoute }) => {
    const root = await temporaryDirectory("vitehub-blob-cached-route-")
    try {
      const plugin = hubBlob({
        driver: "fs",
        serve: { headers, route: serveRoute },
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
                `import { createBlobStorage } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/storage.ts"))}`,
                `export { parseImageVariant } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/media/variant.ts"))}`,
                "const storage = createBlobStorage({",
                "  name: 'blob-route-test',",
                "  async head(pathname) {",
                "    globalThis.__vitehubBlobHeadPaths?.push(pathname)",
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

      const request = await serveRouteRequest(artifactFile, serveRoute, undefined, baseURL, requestRoute)
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
        const conditional = await request("binary.bin", condition)
        expect(conditional.status).toBe(304)
        expect(conditional.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
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
      expect(invalidRange.headers.get("Cache-Control")).toBe(expectedCacheControl)
      expect(invalidRange.headers.get("Content-Range")).toBe("bytes */5")
      expect(invalidRange.headers.get("Content-Length")).toBe("0")
      expect(await invalidRange.text()).toBe("")
      const invalidVariant = await request("binary.bin?w=invalid")
      expect(invalidVariant.status).toBe(400)
      const missing = await request("missing.bin", { "If-None-Match": "*" })
      expect(missing.status).toBe(404)
      expect(missing.headers.get("Cache-Control")).toBeNull()
      for (const result of [response, head, partial, invalidRange, invalidVariant, missing]) {
        expect(result.headers.getSetCookie(), `status ${result.status}`).toEqual(["a=1; Path=/", "b=2; Path=/"])
        expect(result.headers.get("x-middleware"), `status ${result.status}`).toBe("yes")
      }

      const invalidPath = await request("..%2Fsecret")
      expect(invalidPath.status).toBe(400)
      expect(invalidPath.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])

      // The router keeps the raw catch-all after the baseURL; `serve()` decodes it once.
      const paths: string[] = []
      Reflect.set(globalThis, "__vitehubBlobHeadPaths", paths)
      const withBase = await serveRouteRequest(artifactFile, serveRoute, undefined, baseURL || "/app", requestRoute)
      expect((await withBase("dir/a%20b%2Fc.bin", {}, "HEAD")).status).toBe(200)
      expect(paths).toEqual(["dir/a b/c.bin"])
      const emptyPath = await withBase("")
      expect(emptyPath.status).toBe(404)
      expect(emptyPath.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])

      // Outside Nitro, the route keeps the status and headers of the `serve()` Response.
      const { default: route } = await import(pathToFileURL(artifactFile).href) as { default: { fetch: (request: Request) => Promise<Response> } }
      const direct = await route.fetch(new Request(`http://localhost${requestRoute.replace(/\/+$/, "")}/binary.bin`, { headers: { Range: "bytes=1-2" } }))
      expect(direct.status).toBe(206)
      expect(direct.headers.get("Content-Range")).toBe("bytes 1-2/5")
      expect(direct.headers.get("Cache-Control")).toBe(expectedCacheControl)
      expect(new Uint8Array(await direct.arrayBuffer())).toEqual(new Uint8Array([128, 255]))
      for (const [pathname, status] of [["", 404], ["missing.bin", 404], ["..%2Fsecret", 400], ["binary.bin?w=invalid", 400]] as const) {
        const errorHead = await route.fetch(new Request(`http://localhost${requestRoute.replace(/\/+$/, "")}/${pathname}`, { method: "HEAD" }))
        expect(errorHead.status).toBe(status)
        expect(errorHead.body).toBeNull()
      }
      Reflect.deleteProperty(globalThis, "__vitehubBlobHeadPaths")
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it("keeps the Blob sandbox and a middleware CSP on the generated route", async () => {
    const root = await temporaryDirectory("vitehub-blob-route-csp-")
    const plugin = hubBlob({ driver: "fs", serve: true }, { importBase: "virtual:blob-test" })
    await (plugin.configResolved as (config: unknown) => void | Promise<void>)({ build: { outDir: "dist" }, root } as never)
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
        name: "blob-route-csp-stub",
        setup(build) {
          build.onResolve({ filter: /^virtual:blob-test$/ }, () => ({ namespace: "blob-route-csp-stub", path: "blob" }))
          build.onLoad({ filter: /.*/, namespace: "blob-route-csp-stub" }, () => ({
            contents: [
              `import { createBlobStorage } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/storage.ts"))}`,
              `export { parseImageVariant } from ${JSON.stringify(join(workspaceRoot, "packages/blob/src/media/variant.ts"))}`,
              "const types = { 'page.html': 'text/html', 'photo.png': 'image/png' }",
              "const storage = createBlobStorage({",
              "  name: 'blob-route-csp-test',",
              "  async head(pathname) { return { pathname, contentType: types[pathname], size: 7, httpEtag: '\"v1\"', uploadedAt: new Date(0), httpMetadata: {}, customMetadata: {} } },",
              "  async get(pathname) { return new Blob(['content'], { type: types[pathname] }) },",
              "})",
              "export const blob = { store() { return storage } }",
            ].join("\n"),
            resolveDir: workspaceRoot,
            loader: "js",
          }))
        },
      }],
      target: "node24",
    })
    const artifact = await import(pathToFileURL(artifactFile).href) as { default: { fetch: (request: Request) => Promise<Response> } }
    // An empty middleware CSP must not replace the Blob sandbox either.
    for (const appPolicy of ["default-src 'self'", ""]) {
      const app = new H3({ onRequest: event => installStandardContext(event) })
      app.use((event) => {
        event.res.headers.set("content-security-policy", appPolicy)
      })
      app.all("/api/_vitehub/blob/**", artifact.default)
      const request = (pathname: string, headers: Record<string, string> = {}, method = "GET") =>
        app.fetch(new Request(`http://localhost/api/_vitehub/blob/${pathname}`, { headers, method }))
      const pagePolicy = appPolicy ? `${appPolicy}, sandbox` : "sandbox"

      const page = await request("page.html")
      expect(page.status).toBe(200)
      expect(page.headers.get("content-security-policy"), JSON.stringify(appPolicy)).toBe(pagePolicy)
      expect(await page.text()).toBe("content")
      const etag = page.headers.get("etag")!
      for (const [headers, method, status] of [[{}, "HEAD", 200], [{ Range: "bytes=0-1" }, "GET", 206], [{ "If-None-Match": etag }, "GET", 304], [{ "If-None-Match": etag }, "HEAD", 304]] as const) {
        const response = await request("page.html", headers, method)
        expect(response.status, `${method} ${status}`).toBe(status)
        expect(response.headers.get("content-security-policy"), `${JSON.stringify(appPolicy)} ${method} ${status}`).toBe(pagePolicy)
        await response.body?.cancel()
      }
      // A type that runs no script keeps only the app policy.
      const photo = await request("photo.png")
      expect(photo.headers.get("content-security-policy")).toBe(appPolicy)
      await photo.body?.cancel()
    }
  })

  describe("serve authorization", () => {
    const authPlugin = { name: "@vite-hub/auth/vite", api: { getConfig: () => ({ definition: {} }) } }

    async function bundleServeRoute(root: string, priorCacheControl?: string, route = "/photos") {
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
              if (args.path === "better-auth" && ![
                join(workspaceRoot, "packages/auth/src/server.ts"),
                join(workspaceRoot, "packages/auth/src/auth-instance.ts"),
              ].includes(args.importer)) return
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
      return await serveRouteRequest(artifactFile, route, priorCacheControl)
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
        expect(handler).toContain("export default { fetch: withAuthorization(true, (request: Request) => serveBlob(request)) }")

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
        const invalidRange = await request("u1/meal.jpg", { cookie: "session=u1", Range: "bytes=99-" })
        expect(invalidRange.status).toBe(416)
        expect(invalidRange.headers.get("Cache-Control")).toBe("private, no-cache")
        expect(invalidRange.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"])
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
        expect(handler).toContain("export default { fetch: withAuthorization(authorize, (request: Request) => serveBlob(request)) }")

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

    it("runs the anonymous authorize export for signed-out callers", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-anonymous-")
      const calls: string[] = []
      Reflect.set(globalThis, "__vitehubBlobServeCalls", calls)
      try {
        await mkdir(join(root, "server"), { recursive: true })
        await writeFile(join(root, "server", "blob.ts"), [
          "export const authorize = ({ request, session, user }) => {",
          "  const pathname = new URL(request.url).pathname",
          "  if (pathname.startsWith('/f/public/')) return session === null || typeof session.id === 'string'",
          "  if (pathname.startsWith('/f/gone/')) return new Response('Not found', { status: 404 })",
          "  return user !== null && pathname.startsWith(`/f/${user.id}/`)",
          "}",
          "",
        ].join("\n"))
        const plugin = hubBlob({ driver: "fs", serve: { anonymous: true, authorize: true, route: "/f" } }, { importBase: "virtual:blob-test" })
        await (plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [authPlugin],
          root,
        } as never)
        const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
        expect(handler).toContain("import { withAnonymousAuthorization } from \"#vitehub/auth/server\"")
        expect(handler).toContain("export default { fetch: withAnonymousAuthorization(authorize, (request: Request) => serveBlob(request)) }")

        const request = await bundleServeRoute(root, "public, max-age=3600", "/f")
        const shared = await request("public/meal.jpg")
        expect(shared.status).toBe(200)
        expect(shared.headers.get("Cache-Control")).toBe("private, no-cache")
        expect(new Uint8Array(await shared.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]))
        expect((await request("public/meal.jpg", { "If-None-Match": shared.headers.get("etag")! })).status).toBe(304)
        expect((await request("public/meal.jpg", { cookie: "session=u1" })).status).toBe(200)
        expect((await request("gone/meal.jpg")).status).toBe(404)
        const signedOut = await request("u1/meal.jpg")
        expect(signedOut.status).toBe(401)
        expect((await request("u1/meal.jpg", { "If-None-Match": '"photo-v1"' })).status).toBe(401)
        expect((await request("u1/meal.jpg", { cookie: "session=u1" })).status).toBe(200)
        expect((await request("u1/meal.jpg", { cookie: "session=u2" })).status).toBe(403)
        expect(calls).toEqual(["public/meal.jpg", "public/meal.jpg", "public/meal.jpg", "u1/meal.jpg"])
      }
      finally {
        Reflect.deleteProperty(globalThis, "__vitehubBlobServeCalls")
        await rm(root, { force: true, recursive: true })
      }
    })

    it("fails the build when anonymous serving has no authorize export", async () => {
      const root = await temporaryDirectory("vitehub-blob-authorize-anonymous-missing-")
      try {
        const plugin = hubBlob({ driver: "fs", serve: { anonymous: true, authorize: true } })
        await expect((plugin.configResolved as (config: unknown) => void | Promise<void>)({
          build: { outDir: "dist" },
          plugins: [authPlugin],
          root,
        } as never)).rejects.toThrow("`blob.serve.anonymous` requires an `authorize` export")
      }
      finally {
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
        expect(handler).toContain("export default { fetch: withAuthorization(true, (request: Request) => serveBlob(request)) }")
      }
      finally {
        await rm(root, { force: true, recursive: true })
      }
    })
  })

  it("imports the public root through the package base and its runtime state by file path", async () => {
    const root = await temporaryDirectory("vitehub-blob-import-base-")
    const plugin = hubBlob({
      driver: "fs",
      serve: true,
    }, { importBase: "vite-hub/blob" })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    const middleware = await readFile(join(root, ".vitehub", "nitro", "blob", "middleware.ts"), "utf8")
    const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
    const runtimeState = JSON.stringify(join(import.meta.dirname, "../dist/runtime/state.js"))
    expect(nitroPlugin).toContain(`from ${runtimeState}`)
    expect(middleware).toContain(`from ${runtimeState}`)
    expect(handler).toContain("from 'vite-hub/blob'")
    expect(`${nitroPlugin}\n${middleware}\n${handler}`).not.toContain("@vite-hub/blob")
  })
})

describe("hubBlob in vite dev", () => {
  async function resolveConfig(plugin: ReturnType<typeof hubBlob>, command: "build" | "serve", nitro: Record<string, unknown> = {}) {
    const root = await temporaryDirectory("vitehub-blob-dev-remote-")
    await (plugin.configResolved as (config: unknown) => void | Promise<void>)({ build: { outDir: "dist" }, command, nitro, plugins: [{ name: "nitro:main" }], root } as never)
    return root
  }

  it.each(["build", "serve"] as const)("keeps Blob resources and development definitions inspectable in %s", async (command) => {
    const plugin = hubBlob({ bucketName: "uploads" })
    await resolveConfig(plugin, command, { preset: "cloudflare_module" })

    const inspection = plugin.vitehub.inspect!()
    expect(await inspection.resources?.()).toEqual([
      { binding: "BLOB", definition: "default", host: "cloudflare", kind: "cloudflare-r2-bucket", name: "uploads", owner: "blob", source: "name" },
    ])
    const [definitions] = inspection.definitions!
    expect(definitions?.kind).toBe("blob")
    expect(await definitions?.list()).toMatchObject([
      { fields: [{ label: "Development", value: expect.stringContaining("Local.") }], name: "default" },
    ])
  })

  it.each([
    ["vercel", { driver: "vercel-blob" }, false],
    ["vercel", { driver: "vercel-blob" }, true],
    ["netlify", { driver: "netlify-blobs", name: "vitehub-blob" }, false],
    ["netlify", { driver: "netlify-blobs", name: "vitehub-blob" }, true],
    ["cloudflare", { driver: "cloudflare-r2" }, false],
    ["cloudflare", { driver: "cloudflare-r2" }, true],
  ] as const)("keeps the %s preset (%o, remote=%s) when ViteHub replaces Blob options", async (preset, options, remote) => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "")
    vi.stubEnv("BLOB_STORE_ID", "")
    try {
      const plugin = hubBlob(options, { presetDriver: effective => effective === options })
      if (plugin.config && typeof plugin.config !== "function") plugin.config.order = "post"
      const root = await temporaryDirectory("vitehub-blob-app-remote-")
      await resolveViteConfig({
        configFile: false,
        logLevel: "silent",
        plugins: [
          // SAFETY: These private keys carry what the `vitehub()` deployment hook resolves for the owner plugin.
          { name: "app-blob-config", config: () => ({ [VITEHUB_FEATURES]: { blob: { remote } }, [VITEHUB_DEPLOYMENT_PRESET]: preset }) as UserConfig },
          plugin,
        ],
        root,
      }, "serve")

      const developmentDriver = preset === "vercel" && !remote ? "fs" : options.driver
      expect(plugin.api.getConfig().blob).toMatchObject({
        store: { driver: developmentDriver, ...(remote ? { remote: true } : {}) },
      })
      const runtime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
      expect(runtime).toContain(`/drivers/${developmentDriver === "vercel-blob" ? "vercel" : developmentDriver === "cloudflare-r2" ? "cloudflare" : developmentDriver}`)
      const [inspector] = plugin.vitehub.inspect!().definitions!
      expect(await inspector?.list()).toMatchObject([{ fields: [{
        label: "Development",
        value: remote ? expect.stringContaining("Remote.") : preset === "netlify" ? expect.stringContaining("configured `netlify-blobs`") : expect.stringContaining("Local."),
      }] }])
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps a Vercel Blob token in env out of the dev runtime", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "secret-token")
    try {
      const plugin = hubBlob()
      const root = await resolveConfig(plugin, "serve")

      expect(plugin.api.getConfig().blob).toMatchObject({ store: { driver: "fs" } })
      const runtime = await readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
      expect(runtime).toContain("/drivers/fs")
      expect(runtime).not.toContain("/drivers/vercel")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("keeps the build on Vercel Blob with or without remote", async () => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "secret-token")
    try {
      const runtimes = await Promise.all([hubBlob(), hubBlob({ remote: true })].map(async (plugin) => {
        const root = await resolveConfig(plugin, "build")
        return readFile(join(root, ".vitehub", "nitro", "blob", "runtime.mjs"), "utf8")
      }))

      expect(runtimes[0]).toContain("/drivers/vercel")
      expect(runtimes[1]).toBe(runtimes[0])
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it("gives the Cloudflare dev plugin a local fs fallback", async () => {
    const root = await resolveConfig(hubBlob(), "serve", { preset: "cloudflare_module" })

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"localFallback":{"base":".vitehub/data/blob","driver":"fs"}')
  })

  it("keeps the Nitro files that the dev server loads when nuxt prepare replays the build", async () => {
    const plugin = hubBlob({ bucketName: "app-blob", driver: "cloudflare-r2" }, { presetDriver: true })
    const nitro = { preset: "cloudflare_module" }
    const root = await resolveConfig(plugin, "serve", nitro)
    const read = () => Promise.all(["plugin.ts", "middleware.ts", "runtime.mjs"].map(file => readFile(join(root, ".vitehub", "nitro", "blob", file), "utf8")))
    const development = await read()

    await (plugin.configResolved as (config: unknown) => void | Promise<void>)({ build: { outDir: "dist" }, command: "build", nitro, plugins: [{ name: "nitro:main" }], root, [VITEHUB_PREPARE]: true } as never)

    expect(await read()).toEqual(development)
  })

  it("gives the generated dev runtime of a vitehub() R2 store a local fs fallback", async () => {
    const base = await temporaryDirectory("vitehub-blob-dev-fallback-")
    vi.stubEnv("BLOB_FS_BASE", base)
    try {
      const root = await resolveConfig(hubBlob({ bucketName: "app-blob", driver: "cloudflare-r2" }, { presetDriver: true }), "serve")
      const runtime = await import(pathToFileURL(join(root, ".vitehub", "nitro", "blob", "runtime.mjs")).href) as { blob: import("../src/types.ts").BlobStorage }

      const [error] = await runtime.blob.put("hello.txt", "hello")

      expect(error).toBeUndefined()
      expect(await readFile(join(base, "hello.txt"), "utf8")).toBe("hello")
    }
    finally {
      vi.unstubAllEnvs()
    }
  })

  it.each([
    [{ remote: true }, "Remote. `vite dev` uses the real store, so writes change real data."],
    [undefined, "Local. `vite dev` uses the `fs` driver in .vitehub/data/blob."],
  ] as const)("shows the development store of %o in inspect", async (options, development) => {
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "secret-token")
    try {
      const plugin = hubBlob(options)
      await resolveConfig(plugin, "serve")
      const [inspector] = plugin.vitehub.inspect!().definitions!

      expect(inspector?.kind).toBe("blob")
      expect(await inspector?.list()).toEqual([{ fields: [{ label: "Development", value: development }], file: "vite.config", name: "default", source: "blob config" }])
    }
    finally {
      vi.unstubAllEnvs()
    }
  })
})
