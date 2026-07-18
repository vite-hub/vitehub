import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { getCloudflareRateLimitBindingName } from "../src/integrations/cloudflare.ts"
import { hubRateLimit } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

async function writeCloudflareDeclaration(root: string): Promise<void> {
  await writeFile(join(root, "upload.ts"), [
    'import { defineRateLimit } from "@vite-hub/rate-limit"',
    'const upload = defineRateLimit("upload", { enforcement: "best-effort", limit: 10, window: "1m" })',
    "void upload",
    "",
  ].join("\n"))
}

describe("hubRateLimit", () => {
  it("composes discovered Rate Limits into a Nitro Cloudflare Worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-nitro-cloudflare-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const plugin = hubRateLimit({ namespace: "vite-test" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => { nitro: Record<string, unknown> }
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = {
      nitro: {
        cloudflare: { wrangler: { ratelimits: [{ name: "MANUAL", namespace_id: "9", simple: { limit: 1, period: 10 } }] } },
        preset: "cloudflare-module",
      },
      root,
    }

    const configured = config(userConfig, { command: "build" })
    expect(configured.nitro).toMatchObject({
      cloudflare: {
        wrangler: {
          ratelimits: [
            { name: "MANUAL" },
            { name: getCloudflareRateLimitBindingName("upload"), simple: { limit: 10, period: 60 } },
          ],
        },
      },
    })

    const resolvedConfig = { ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [], resolve: { alias: [] } }
    await configResolved(resolvedConfig as never)
    expect(resolvedConfig.nitro.cloudflare.wrangler.ratelimits).toHaveLength(2)
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
      plugins: [],
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
    const memoryConfig = memoryPlugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => { nitro: Record<string, unknown> }
    expect(memoryConfig({ nitro: { preset: "cloudflare-module" }, root }, { command: "build" }).nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")

    const vercelPlugin = hubRateLimit({ namespace: "vite-test", provider: "cloudflare" })
    const vercelConfig = vercelPlugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" }) => { nitro: Record<string, unknown> }
    expect(vercelConfig({ nitro: { preset: "vercel" }, root }, { command: "build" }).nitro).not.toHaveProperty("cloudflare.wrangler.ratelimits")
  })

  it("keeps standalone output when hosting inference has no Nitro preset", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-plain-cloudflare-"))
    roots.push(root)
    await writeCloudflareDeclaration(root)
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.VITEHUB_HOSTING = "cloudflare"
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
      if (previousHosting === undefined) delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
    }
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
    await configResolved({ ...userConfig, build: { outDir: "dist" }, command: "build", plugins: [], resolve: { alias: [] } } as never)
    await writeCloudflareDeclaration(root)

    await expect(closeBundle()).rejects.toThrow("changed after config resolution")
  })

  it("registers generated Nitro runtime with config-key precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = { nitro: { plugins: ["server/plugin.ts"] }, rateLimit: { projectRoot: ".", provider: "memory" } }
    expect(config(userConfig)).toMatchObject({
      nitro: { plugins: [".vitehub/nitro/rate-limit/plugin.ts", "server/plugin.ts"] },
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
    expect(installer).toContain("enterRateLimitRuntimeEvent(event)")
  })

  it("installs the Cloudflare runtime in plain Vite SSR modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-plain-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", projectRoot: ".", provider: "cloudflare" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const transform = plugin.transform as unknown as (code: string, id: string) => string | undefined
    const entry = join(root, "server.ts")
    await writeFile(entry, 'import { defineRateLimit } from "@vite-hub/rate-limit"\nconst uploads = defineRateLimit("uploads", { enforcement: "best-effort", limit: 1, window: "1m" })\n')
    await configResolved({
      build: { outDir: "dist", ssr: "server.ts" },
      command: "build",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)

    const result = transform('import { defineRateLimit } from "@vite-hub/rate-limit"', entry)
    expect(result).toContain(`${join(root, ".vitehub", "rate-limit", "cloudflare-runtime.mjs")}"`)
  })

  it("removes the legacy generated registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-legacy-registry-"))
    roots.push(root)
    const registry = join(root, ".vitehub", "nitro", "rate-limit", "registry.mjs")
    await mkdir(join(root, ".vitehub", "nitro", "rate-limit"), { recursive: true })
    await writeFile(registry, "export default {}\n")

    const plugin = hubRateLimit({ provider: "memory" })
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      resolve: { alias: [] },
      root,
    } as never)

    await expect(access(registry)).rejects.toMatchObject({ code: "ENOENT" })
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

  it("collects source-local handles into the inspectable manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-manifest-"))
    roots.push(root)
    await writeFile(join(root, "search.ts"), [
      'import { defineRateLimit } from "@vite-hub/rate-limit"',
      'const search = defineRateLimit("search", { limit: 1, window: "1m" })',
      "void search",
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
          metadata: {
            remaining: { availability: "always", quality: "exact" },
            resetAt: { availability: "always", quality: "exact" },
            retryAfter: { availability: "on-rejection", quality: "exact" },
            used: { availability: "always", quality: "exact" },
          },
          rejectedAttempts: "not-counted",
          scope: "process",
        },
        name: "search",
        provider: "memory",
      }],
      schemaVersion: 1,
    })
  })
})
