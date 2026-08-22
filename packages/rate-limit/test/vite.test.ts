import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"
import { getCloudflareRateLimitBindingName } from "../src/integrations/cloudflare.ts"
import { hubRateLimit } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

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
  it("fails configuration for conflicting policies with the same ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-conflicting-policies-"))
    roots.push(root)
    await writeFile(join(root, "first.ts"), 'import { requireRateLimit } from "@vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 1, window: "1m" })\n')
    await writeFile(join(root, "second.ts"), 'import { requireRateLimit } from "@vite-hub/rate-limit"\nrequireRateLimit(event, "upload", { limit: 2, window: "1m" })\n')
    const plugin = hubRateLimit({ provider: "memory" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "serve" }) => void

    expect(() => config({ root }, { command: "serve" }))
      .toThrow(/Conflicting Rate Limit policies[\s\S]*first\.ts:2:1[\s\S]*second\.ts:2:1/)
  })

  it("composes discovered Rate Limits into a Nitro Cloudflare Worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-cloudflare-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = {
      nitro: {
        cloudflare: { wrangler: { ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }] } },
        preset: "cloudflare-module",
      },
      root,
    }

    expect(config(userConfig, { command: "build" })).toBeUndefined()
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
    await (plugin.closeBundle as () => Promise<void>)()
    await expect(access(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("requires a namespace for discovered Nitro Cloudflare Rate Limits", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-namespace-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit()
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown

    expect(() => config({ nitro: { preset: "cloudflare-module" }, root }, { command: "build" })).toThrow("requires rateLimit.namespace")
  })

  it("composes after a Cloudflare Nitro preset resolves late", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-late-preset-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: "." })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
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
    const memoryConfig = memoryPlugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const memoryUserConfig = { nitro: { preset: "cloudflare-module" }, root }
    memoryConfig(memoryUserConfig, { command: "build" })
    expect(memoryUserConfig.nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")

    const vercelPlugin = hubRateLimit({ namespace: "vite-test", provider: "cloudflare" })
    const vercelConfig = vercelPlugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => void
    const vercelUserConfig = { nitro: { preset: "vercel" }, root }
    vercelConfig(vercelUserConfig, { command: "build" })
    expect(vercelUserConfig.nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET", "VITEHUB_HOSTING"])("keeps standalone output without Nitro when hosting is selected by %s", async (environmentVariable) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-plain-cloudflare-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const previousHosting = process.env[environmentVariable]
    process.env[environmentVariable] = "cloudflare"
    try {
      const plugin = hubRateLimit({ namespace: "vite-test" })
      const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      const closeBundle = plugin.closeBundle as () => Promise<void>
      const userConfig = { root }

      config(userConfig, { command: "build" })
      await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [], resolve: { alias: [] } } as never)
      await closeBundle()

      const [appOutput] = await readdir(join(root, "dist"))
      await expect(readFile(join(root, "dist", appOutput!, "wrangler.json"), "utf8")).resolves.toContain(getCloudflareRateLimitBindingName("upload"))
    }
    finally {
      if (previousHosting === undefined) delete process.env[environmentVariable]
      else process.env[environmentVariable] = previousHosting
    }
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET", "VITEHUB_HOSTING"])("composes and suppresses output for real Nitro hosting selected by %s", async (environmentVariable) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-cloudflare-env-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const previousHosting = process.env[environmentVariable]
    process.env[environmentVariable] = "cloudflare"
    try {
      const plugin = hubRateLimit({ namespace: "vite-test" })
      const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
      const userConfig = { nitro: {}, root }

      config(userConfig, { command: "build" })
      await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [{ name: "nitro:main" }], resolve: { alias: [] } } as never)
      expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.ratelimits", [
        expect.objectContaining({ name: getCloudflareRateLimitBindingName("upload") }),
      ])
      await (plugin.closeBundle as () => Promise<void>)()

      await expect(access(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"))).rejects.toMatchObject({ code: "ENOENT" })
    }
    finally {
      if (previousHosting === undefined) delete process.env[environmentVariable]
      else process.env[environmentVariable] = previousHosting
    }
  })

  it("keeps standalone output when Cloudflare config has no Nitro plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-plain-cloudflare-config-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const closeBundle = plugin.closeBundle as () => Promise<void>
    const userConfig = { nitro: { preset: "cloudflare-module" }, root }

    config(userConfig, { command: "build" })
    await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [], resolve: { alias: [] } } as never)
    await closeBundle()

    await expect(readFile(join(createDefaultCloudflareOutputRoot(root), "wrangler.json"), "utf8")).resolves.toContain(getCloudflareRateLimitBindingName("upload"))
  })

  it("rejects Nitro Rate Limit declarations generated after config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-late-declaration-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const closeBundle = plugin.closeBundle as () => Promise<void>
    const userConfig = { nitro: { preset: "cloudflare-module" }, root }

    config(userConfig, { command: "build" })
    await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [{ name: "nitro:main" }], resolve: { alias: [] } } as never)
    await writeCloudflareDeclaration(root)

    await expect(closeBundle()).rejects.toThrow("changed after config resolution")
  })

  it("registers provider runtime without global request middleware", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = {
      nitro: {
        handlers: [{ handler: "server/middleware.ts", middleware: true, route: "/**" }],
        plugins: ["server/plugin.ts"],
      },
      rateLimit: { projectRoot: ".", provider: "memory" },
    }
    expect(config(userConfig)).toBeUndefined()
    expect(userConfig).toMatchObject({
      nitro: {
        handlers: [
          { handler: "server/middleware.ts", middleware: true, route: "/**" },
        ],
        plugins: [".vitehub/nitro/rate-limit/plugin.ts", "server/plugin.ts"],
      },
    })

    await configResolved({
      build: { outDir: "dist" },
      command: "build",
      nitro: userConfig.nitro,
      plugins: [],
      rateLimit: userConfig.rateLimit,
      resolve: { alias: [] },
      root,
    } as never)

    const installer = await readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")
    expect(installer).toContain('const config = {"provider":"memory"}')
    expect(installer).not.toContain("Registry")
    await expect(access(join(root, ".vitehub", "nitro", "rate-limit", "middleware.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("installs the Cloudflare runtime in plain Vite SSR modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-plain-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const transform = plugin.transform as unknown as (code: string, id: string) => string | undefined
    const entry = join(root, "server.ts")
    await writeFile(entry, 'import { requireRateLimit } from "@vite-hub/rate-limit"\nexport async function upload(event) { await requireRateLimit(event, "uploads", { enforcement: "best-effort", limit: 1, window: "1m" }) }\n')
    await configResolved({
      build: { outDir: "dist", ssr: "server.ts" },
      command: "build",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)

    const result = transform('import { requireRateLimit } from "@vite-hub/rate-limit"', entry)
    expect(result).toContain(`${join(root, ".vitehub", "rate-limit", "cloudflare-runtime.mjs")}"`)
  })

  it("installs the Cloudflare runtime in every module sharing a Rate Limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-shared-plain-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const transform = plugin.transform as unknown as (code: string, id: string) => string | undefined
    const entries = [join(root, "first.ts"), join(root, "second.ts")]
    for (const entry of entries) {
      await writeFile(entry, 'import { requireRateLimit } from "@vite-hub/rate-limit"\nexport async function upload(event) { await requireRateLimit(event, "uploads", { limit: 1, window: "1m" }) }\n')
    }
    await configResolved({
      build: { outDir: "dist", ssr: "first.ts" },
      command: "build",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)

    for (const entry of entries) {
      expect(transform("export {}", entry)).toContain(`${join(root, ".vitehub", "rate-limit", "cloudflare-runtime.mjs")}"`)
    }
  })

  it("uses the configured internal import base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-import-base-"))
    roots.push(root)
    const plugin = hubRateLimit({ importBase: "vite-hub/_internal/rate-limit" } as never)
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)
    const installer = await readFile(join(root, ".vitehub", "nitro", "rate-limit", "plugin.ts"), "utf8")
    expect(installer).toContain('from "vite-hub/_internal/rate-limit/runtime"')
    expect(installer).not.toContain("@vite-hub/rate-limit/runtime")
    await expect(access(join(root, ".vitehub", "nitro", "rate-limit", "middleware.ts"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fails automatic hosted fallback where no native driver exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vercel-"))
    roots.push(root)
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.VITEHUB_HOSTING = "vercel"
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
      if (previousHosting === undefined) delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
    }
  })

  it("requires an explicit provider for unknown production hosting", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-unknown-build-"))
    roots.push(root)
    const previousHosting = process.env.VITEHUB_HOSTING
    delete process.env.VITEHUB_HOSTING
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
      if (previousHosting !== undefined) process.env.VITEHUB_HOSTING = previousHosting
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
})
