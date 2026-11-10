import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"
import { VITEHUB_DEPLOYMENT_HOST, VITEHUB_FEATURES } from "@vite-hub/internal/build/vite"

import { getCloudflareRateLimitBindingName } from "../src/integrations/cloudflare.ts"
import { hubRateLimit } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

function runBuildEnd(plugin: ReturnType<typeof hubRateLimit>): void {
  // doctor-disable-next-line typescript/evidence/no-chained-type-assertions -- SAFETY: hubRateLimit owns this callable Vite lifecycle hook in the focused test.
  ;(plugin.buildEnd as unknown as () => void)()
}

async function writeCloudflareDeclaration(root: string): Promise<void> {
  await writeFile(join(root, "upload.ts"), [
    'import { requireRateLimit } from "@vite-hub/rate-limit"',
    "export async function upload(event) {",
    '  await requireRateLimit(event, "upload", { enforcement: "best-effort", limit: 10, window: "1m" })',
    "}",
    "",
  ].join("\n"))
}

describe("hubRateLimit", () => {
  it("writes generated files at the project root when Vite runs from app/", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-project-root-"))
    roots.push(root)
    await mkdir(join(root, "app"), { recursive: true })
    await writeFile(join(root, "package.json"), "{}")
    const plugin = hubRateLimit({ provider: "memory" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      resolve: { alias: [] },
      root: join(root, "app"),
    } as never)

    await expect(readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")).resolves.toContain("setRateLimitRuntimeConfig")
    await expect(readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8")).resolves.toContain('"schemaVersion"')
    await expect(readFile(join(root, "app", ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails configuration for conflicting policies with the same ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-conflicting-policies-"))
    roots.push(root)
    await writeFile(join(root, "first.ts"), 'import { requireRateLimit } from "@vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 1, window: "1m" })\n')
    await writeFile(join(root, "second.ts"), 'import { requireRateLimit } from "@vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 2, window: "1m" })\n')
    const plugin = hubRateLimit({ provider: "memory" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "serve" }) => void

    expect(() => config({ root }, { command: "serve" }))
      .toThrow(/Conflicting Rate Limit policies[\s\S]*first\.ts:2:1[\s\S]*second\.ts:2:1/)
  })

  it("composes discovered Rate Limits into a Nitro Cloudflare Worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-cloudflare-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = {
      nitro: {
        cloudflare: { wrangler: { ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }] } },
        preset: "cloudflare-module",
      },
      root,
    }

    expect(await config(userConfig, { command: "build" })).toBeUndefined()
    expect(userConfig.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          ratelimits: [
            { name: "MANUAL" },
            { name: getCloudflareRateLimitBindingName("upload"), simple: { limit: 10, period: 60 } },
          ],
        },
      },
    })

    const resolvedConfig = { ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [{ name: "nitro:main" }], resolve: { alias: [] } }
    await configResolved(resolvedConfig as never)
    expect(resolvedConfig.nitro.cloudflare.wrangler.ratelimits).toHaveLength(2)
    runBuildEnd(plugin)
    await expect(access(join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires a namespace for discovered Nitro Cloudflare Rate Limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-namespace-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit()
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown

    expect(() => config({ nitro: { preset: "cloudflare-module" }, root }, { command: "build" })).toThrow("requires rateLimit.namespace")
  })

  it("composes after a Cloudflare Nitro preset resolves late", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-late-preset-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: "." })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>

    expect(() => config({ nitro: {}, root }, { command: "build" })).not.toThrow()
    const resolvedConfig = {
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      resolve: { alias: [] },
      root,
    }
    await configResolved(resolvedConfig as never)
    expect(resolvedConfig).toHaveProperty("nitro.cloudflare.wrangler.ratelimits", [
      expect.objectContaining({ name: getCloudflareRateLimitBindingName("upload") }),
    ])
  })

  it("does not compose bindings for memory or non-Cloudflare Nitro builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-other-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const memoryPlugin = hubRateLimit({ provider: "memory" })
    const memoryConfig = (typeof memoryPlugin.config === "function" ? memoryPlugin.config : memoryPlugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const memoryUserConfig = { nitro: { preset: "cloudflare-module" }, root }
    memoryConfig(memoryUserConfig, { command: "build" })
    expect(memoryUserConfig.nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")

    const vercelPlugin = hubRateLimit({ namespace: "vite-test", provider: "cloudflare" })
    const vercelConfig = (typeof vercelPlugin.config === "function" ? vercelPlugin.config : vercelPlugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const vercelUserConfig = { nitro: { preset: "vercel" }, root }
    vercelConfig(vercelUserConfig, { command: "build" })
    expect(vercelUserConfig.nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET", "VITEHUB_HOST"])("composes Nitro hosting selected by %s", async (environmentVariable) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-cloudflare-env-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const previousHosting = process.env[environmentVariable]
    process.env[environmentVariable] = "cloudflare"
    try {
      const plugin = hubRateLimit({ namespace: "vite-test" })
      const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      const userConfig = { nitro: {}, root }

      config(userConfig, { command: "build" })
      await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [{ name: "nitro:main" }], resolve: { alias: [] } } as never)
      expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.ratelimits", [
        expect.objectContaining({ name: getCloudflareRateLimitBindingName("upload") }),
      ])
      runBuildEnd(plugin)

      await expect(access(join(root, "dist"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      if (previousHosting === undefined) delete process.env[environmentVariable]
      else process.env[environmentVariable] = previousHosting
    }
  })

  it("rejects Nitro Rate Limit declarations generated after config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-late-declaration-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = { nitro: { preset: "cloudflare-module" }, root }

    config(userConfig, { command: "build" })
    await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [{ name: "nitro:main" }], resolve: { alias: [] } } as never)
    await writeCloudflareDeclaration(root)

    expect(() => runBuildEnd(plugin)).toThrow("changed after config resolution")
  })

  it("registers provider runtime without global request middleware", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = {
      nitro: {
        handlers: [{ handler: "server/middleware.ts", middleware: true, route: "/**" }],
        plugins: ["server/plugin.ts"],
      },
      [VITEHUB_FEATURES]: { rateLimit: { projectRoot: ".", provider: "memory" } },
      root,
    }
    expect(await config(userConfig)).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        handlers: [
          { handler: "server/middleware.ts", middleware: true, route: "/**" },
        ],
        plugins: [join(root, ".vitehub/nitro/rate-limit/plugin.ts"), "server/plugin.ts"],
      },
    })

    await configResolved({
      build: { outDir: "dist" },
      command: "build",
      nitro: userConfig.nitro,
      plugins: [],
      [VITEHUB_FEATURES]: userConfig[VITEHUB_FEATURES],
      resolve: { alias: [] },
      root,
    } as never)

    const installer = await readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")
    expect(installer).toContain('const config = {"provider":"memory"}')
    expect(installer).not.toContain("Registry")
    await expect(access(join(root, ".vitehub", "nitro", "rate-limit", "middleware.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("imports its runtime by file path, not through a package export", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-runtime-path-"))
    roots.push(root)
    const plugin = hubRateLimit()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)
    const installer = await readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")
    expect(installer).toContain(`from ${JSON.stringify(join(import.meta.dirname, "../dist/runtime.js"))}`)
    expect(installer).not.toContain("@vite-hub/rate-limit/runtime")
    await expect(access(join(root, ".vitehub", "nitro", "rate-limit", "middleware.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("leaves operation RPC installation to the root integration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-operations-"))
    roots.push(root)
    const plugin = hubRateLimit()
    const config = (typeof plugin.config === "function" ? plugin.config : plugin.config!.handler) as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const serveConfig: Record<string, unknown> = { nitro: { baseURL: "/app/" }, root, plugins: [plugin, { name: "vite-hub/dependencies" }] }
    expect(await config(serveConfig, { command: "serve" })).toBeUndefined()
    expect(serveConfig.nitro).toMatchObject({ baseURL: "/app/", handlers: [] })

    await (plugin.configResolved as (config: unknown) => Promise<void>)({ build: { outDir: "dist" }, command: "serve", plugins: [], resolve: { alias: [] }, root } as never)
    await expect(access(join(root, ".vitehub", "nitro", "rate-limit", "dev-handler.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("contributes the rate-limit operations", () => {
    expect(hubRateLimit().vitehub.operations).toEqual([expect.objectContaining({ export: "rateLimitOperations", module: join(import.meta.dirname, "../dist/operations.js") })])
  })

  it("contributes the `vitehub rate-limit` CLI commands", async () => {
    const cli = hubRateLimit().vitehub.cli
    const contributor = typeof cli === "function" ? await cli() : cli
    expect(contributor?.namespaces.map(namespace => [namespace.name, namespace.features.map(feature => feature.name)])).toEqual([["rate-limit", ["peek", "reset"]]])
  })

  it("fails automatic hosted fallback where no native driver exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vercel-"))
    roots.push(root)
    const previousHosting = process.env.VITEHUB_HOST
    process.env.VITEHUB_HOST = "vercel"
    try {
      const plugin = hubRateLimit()
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      await expect(configResolved({
        build: { outDir: "dist" },
        command: "build",
        plugins: [],
        resolve: { alias: [] },
        root,
      } as never)).rejects.toThrow("no native vercel driver")
    }
    finally {
      if (previousHosting === undefined) delete process.env.VITEHUB_HOST
      else process.env.VITEHUB_HOST = previousHosting
    }
  })

  it("requires an explicit provider for unknown production hosting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-unknown-build-"))
    roots.push(root)
    const previousHosting = process.env.VITEHUB_HOST
    delete process.env.VITEHUB_HOST
    try {
      const plugin = hubRateLimit()
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      await expect(configResolved({
        build: { outDir: "dist" },
        command: "build",
        plugins: [],
        resolve: { alias: [] },
        root,
      } as never)).rejects.toThrow("cannot be inferred for a production build")
    }
    finally {
      if (previousHosting !== undefined) process.env.VITEHUB_HOST = previousHosting
    }
  })

  it("infers Cloudflare only for a known Cloudflare production build", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-cloudflare-build-"))
    roots.push(root)
    const plugin = hubRateLimit()
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare-module" },
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)
    const installer = await readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")
    expect(installer).toContain('const config = {"provider":"cloudflare"}')
  })

  it("collects handler-local guards into the inspectable manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-manifest-"))
    roots.push(root)
    await writeFile(join(root, "search.ts"), [
      'import { requireRateLimit } from "@vite-hub/rate-limit"',
      "export async function search(event) {",
      '  await requireRateLimit(event, "search", { limit: 1, window: "1m" })',
      "}",
      "",
    ].join("\n"))
    const plugin = hubRateLimit({ provider: "memory" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)
    await expect(readFile(join(root, ".vitehub", "rate-limit", "manifest.json"), "utf8").then(JSON.parse)).resolves.toEqual({
      rateLimits: [{
        capabilities: {
          enforcement: "strict",
          rejectedAttempts: "not-counted",
          scope: "process",
        },
        name: "search",
        provider: "memory",
      }],
      schemaVersion: 2,
    })
  })

  describe("dev server for a Cloudflare build", () => {
    async function devRoot(window: string, enforcement = "best-effort"): Promise<string> {
      const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-dev-cloudflare-"))
      roots.push(root)
      await writeFile(join(root, "upload.ts"), [
        'import { requireRateLimit } from "@vite-hub/rate-limit"',
        "export async function upload(event) {",
        `  await requireRateLimit(event, "upload", { enforcement: "${enforcement}", limit: 10, window: "${window}" })`,
        "}",
        "",
      ].join("\n"))
      return root
    }

    function serve(plugin: ReturnType<typeof hubRateLimit>, config: Record<string, unknown>): Promise<void> {
      return (plugin.configResolved as (config: unknown) => Promise<void>)({
        build: { outDir: "dist" },
        command: "serve",
        plugins: [],
        resolve: { alias: [] },
        ...config,
      } as never)
    }

    it("rejects a window that Cloudflare Rate Limiting does not support, as the build does", async () => {
      const root = await devRoot("1h")

      await expect(serve(hubRateLimit(), { nitro: { preset: "cloudflare-module" }, root }))
        .rejects.toMatchObject({ code: "RATE_LIMIT_R0016", message: expect.stringContaining("supports only 10s and 1m windows") })
      await expect(serve(hubRateLimit({ provider: "cloudflare" }), { root }))
        .rejects.toMatchObject({ code: "RATE_LIMIT_R0016" })
      // vitehub({ host: "cloudflare" }) records its host and runs memory in dev.
      await expect(serve(hubRateLimit({ provider: "cloudflare" }), { [VITEHUB_FEATURES]: { rateLimit: { provider: "memory" } }, root, [VITEHUB_DEPLOYMENT_HOST]: "cloudflare" }))
        .rejects.toMatchObject({ code: "RATE_LIMIT_R0016" })
    })

    it("rejects strict enforcement, as the build does", async () => {
      const root = await devRoot("1m", "strict")

      await expect(serve(hubRateLimit(), { nitro: { preset: "cloudflare-module" }, root }))
        .rejects.toMatchObject({ code: "RATE_LIMIT_R0015" })
      await expect(serve(hubRateLimit({ provider: "cloudflare" }), { [VITEHUB_FEATURES]: { rateLimit: { provider: "memory" } }, root, [VITEHUB_DEPLOYMENT_HOST]: "cloudflare" }))
        .rejects.toMatchObject({ code: "RATE_LIMIT_R0015" })
    })

    it.each([
      ["1h", "best-effort"],
      ["1m", "strict"],
    ])("honors a resolved memory override for %s with %s enforcement in dev and build", async (window, enforcement) => {
      const root = await devRoot(window, enforcement)
      const config = { nitro: { preset: "cloudflare-module" }, [VITEHUB_FEATURES]: { rateLimit: { provider: "memory" } }, root }

      await serve(hubRateLimit({ provider: "cloudflare" }), config)
      await expect(readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")).resolves.toContain('{"provider":"memory"}')
      await serve(hubRateLimit({ provider: "cloudflare" }), { ...config, command: "build" })
    })

    it("logs an unsupported policy that a saved file adds", async () => {
      const root = await devRoot("1m")
      const plugin = hubRateLimit()
      const errors: string[] = []
      const config = { build: { outDir: "dist" }, command: "serve", logger: { error: (message: string) => errors.push(message) }, nitro: { preset: "cloudflare-module" }, plugins: [], resolve: { alias: [] }, root }
      await serve(plugin, config)
      await writeFile(join(root, "upload.ts"), 'import { requireRateLimit } from "@vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 10, window: "30s" })\n')

      await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({ file: join(root, "upload.ts"), server: { config } })

      expect(errors).toEqual([expect.stringMatching(/^RATE_LIMIT_R0016: .*supports only 10s and 1m windows/)])
    })

    it("keeps the memory driver for supported policies and for dev without a Cloudflare build", async () => {
      const valid = await devRoot("10s")
      await serve(hubRateLimit(), { nitro: { preset: "cloudflare-module" }, root: valid })
      await expect(readFile(join(valid, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")).resolves.toContain('{"provider":"memory"}')
      await serve(hubRateLimit({ provider: "cloudflare" }), { [VITEHUB_FEATURES]: { rateLimit: { provider: "memory" } }, root: valid, [VITEHUB_DEPLOYMENT_HOST]: "cloudflare" })
      await expect(readFile(join(valid, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")).resolves.toContain('{"provider":"memory"}')

      const local = await devRoot("1h")
      await serve(hubRateLimit(), { root: local })
      await serve(hubRateLimit({ provider: "memory" }), { nitro: { preset: "cloudflare-module" }, root: local })
    })
  })
})
