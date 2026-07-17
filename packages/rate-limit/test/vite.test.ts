import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { hubRateLimit } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubRateLimit", () => {
  it("registers generated Nitro runtime with config-key precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-rate-limit-vite-"))
    roots.push(root)
    const plugin = hubRateLimit({ namespace: "vite-test", provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const userConfig = { nitro: { plugins: ["server/plugin.ts"] }, rateLimit: { provider: "memory" } }
    expect(config(userConfig)).toMatchObject({
      nitro: { plugins: ["server/plugin.ts", ".vitehub/nitro/rate-limit/plugin.ts"] },
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
