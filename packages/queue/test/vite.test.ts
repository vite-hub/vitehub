import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { createDefaultCloudflareOutputRoot } from "@vite-hub/internal/build/deployment-output"

import { hubQueue } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("hubQueue", () => {
  it("registers and generates the Nitro queue runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    const plugin = hubQueue({ provider: "cloudflare" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => Promise<void>
    const external = /^node:/
    const userConfig = { nitro: { cloudflare: { wrangler: { compatibility_flags: ["custom"] } }, plugins: ["server/plugin.ts"], rollupConfig: { external } }, root }

    config(userConfig)
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { compatibility_flags: ["custom", "nodejs_compat"], queues: { consumers: [{ queue: "queue--77656c636f6d65" }], producers: [{ binding: "QUEUE_77656C636F6D65", queue: "queue--77656c636f6d65" }] } } },
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
        rollupConfig: { external: [external, "cloudflare:workers"] },
      },
    })
    expect((userConfig.nitro.rollupConfig.external as unknown as unknown[])[0]).toBe(external)
    config(userConfig)
    expect(userConfig).toMatchObject({
      nitro: { plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"] },
    })

    await configResolved({
      build: { outDir: "dist" },
      command: "serve",
      plugins: [],
      queue: { provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    const registry = await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")
    expect(nitroPlugin).toContain("setQueueRuntimeConfig(queueConfig)")
    expect(nitroPlugin).toContain("setQueueRuntimeRegistry(queueRegistry)")
    expect(nitroPlugin).toContain("event.context?.cloudflare?.env")
    expect(nitroPlugin).toContain("event.req?.runtime?.cloudflare?.env")
    expect(nitroPlugin).toContain("event.node?.req?.runtime?.cloudflare?.env")
    expect(nitroPlugin).toContain("waitUntil: vitehubWaitUntil")
    expect(nitroPlugin).toContain("setQueueRuntimeEventDefaults({ env: vitehubEnv, waitUntil: vitehubWaitUntil })")
    expect(nitroPlugin).toContain("cloudflare:queue")
    expect(nitroPlugin).toContain("queueWorker.queue(batch, env, context)")
    expect(registry).toContain("welcome.queue.ts")
  })

  it("infers providers for generated Nitro runtime imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).toContain("import * as __vitehubVercelQueue from '@vercel/queue'")
  })

  it("uses the Nitro host instead of a mismatched explicit provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-host-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { nitro: { preset: "vercel" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    expect(config).not.toHaveProperty("nitro.cloudflare")
    expect(config).not.toHaveProperty("nitro.rollupConfig.external")
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ ...config, queue: { provider: "cloudflare" } } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain("const queueConfig = false")
    expect(nitroPlugin).not.toContain("@vercel/queue")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
    expect(nitroPlugin).not.toContain("cloudflare:queue")
  })

  it("enables inferred queue config when hubQueue options are omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue()
    const userConfig = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(userConfig)
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.queues.producers")
    expect(userConfig).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ root, nitro: { preset: "vercel" } } as never)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"provider": "vercel"')
    expect(nitroPlugin).not.toContain("const queueConfig = false")
  })

  it("does not load the optional Vercel SDK without definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue({})
    await (plugin.configResolved as (config: unknown) => Promise<void>)({ queue: {}, root, nitro: { preset: "vercel" } } as never)
    expect(await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).not.toContain("@vercel/queue")
  })

  it("refreshes the Nitro registry when Queue Definitions change", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue({ provider: "vercel" })
    const resolved = { root, nitro: { preset: "vercel" } }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolved as never)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
      file: definition,
      server: { config: resolved },
    })
    expect(await readFile(join(root, ".vitehub", "queue", "registry.mjs"), "utf8")).toContain("welcome.queue.ts")
  })

  it("uses the final Nitro preset and skips disabled runtime registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue()
    const initial = { nitro: {}, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(initial)
    expect(initial.nitro).not.toHaveProperty("cloudflare")
    const resolved = { build: { outDir: "dist" }, command: "build", nitro: { ...initial.nitro, preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], queue: undefined, root }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolved as never)
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.queues.producers")
    expect(resolved).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(false)

    const disabled = { nitro: { preset: "cloudflare_module", plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"] }, queue: false, root }
    ;(hubQueue(false).config as unknown as (config: Record<string, unknown>) => void)(disabled)
    expect(disabled.nitro.plugins).toEqual(["server/plugin.ts"])
    expect(disabled.nitro).not.toHaveProperty("cloudflare")
  })

  it("preserves custom bindings and skips Cloudflare Pages consumers", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare", binding: "JOBS" })
    const config = plugin.config as unknown as (config: Record<string, unknown>) => void
    const moduleConfig = { nitro: { preset: "cloudflare_module" }, root }
    config(moduleConfig)
    expect(moduleConfig).toMatchObject({
      nitro: { cloudflare: { wrangler: { queues: { producers: [{ binding: "JOBS" }] } } } },
    })
    const underscorePages = { nitro: { preset: "cloudflare_pages" }, root }
    config(underscorePages)
    expect(underscorePages).toMatchObject({
      nitro: {
        cloudflare: {
          wrangler: {
            compatibility_flags: ["nodejs_compat"],
            queues: { producers: [{ binding: "JOBS", queue: "queue--77656c636f6d65" }] },
          },
        },
      },
    })
    expect(underscorePages.nitro).not.toHaveProperty("cloudflare.wrangler.queues.consumers")
    expect(underscorePages.nitro).not.toHaveProperty("rollupConfig.external")
    const hyphenPages = { nitro: { preset: "cloudflare-pages" }, root }
    config(hyphenPages)
    expect(hyphenPages).toHaveProperty("nitro.cloudflare.wrangler.queues.producers", [{ binding: "JOBS", queue: "queue--77656c636f6d65" }])
    expect(hyphenPages.nitro).not.toHaveProperty("cloudflare.wrangler.queues.consumers")

    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: underscorePages.nitro,
      plugins: [],
      queue: { binding: "JOBS", provider: "cloudflare" },
      resolve: { alias: [] },
      root,
    } as never)
    const pagesPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
    expect(pagesPlugin).not.toContain("cloudflare:queue")
    expect(pagesPlugin).not.toContain("cloudflare:workers")
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
  })

  it("keeps standalone output when Queue targets Cloudflare but Nitro does not", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { build: { outDir: "dist" }, command: "build", nitro: { preset: "vercel" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
    await (plugin.closeBundle as () => Promise<void>)()
    expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
  })

  it.each(["NITRO_PRESET", "SERVER_PRESET", "VITEHUB_HOSTING"])("keeps standalone output after Blob's Nitro bridge when selected by %s", async (environmentVariable) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")
    const previous = process.env[environmentVariable]
    process.env[environmentVariable] = "cloudflare_module"

    try {
      const plugin = hubQueue()
      const config = { build: { outDir: "dist" }, command: "build", nitro: { plugins: [".vitehub/nitro/blob/plugin.ts"] }, plugins: [{ name: "@vite-hub/blob/vite" }], root }
      ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
      await (plugin.configResolved as (config: unknown) => Promise<void>)(config as never)
      await (plugin.closeBundle as () => Promise<void>)()
      expect(existsSync(join(createDefaultCloudflareOutputRoot(root), "index.js"))).toBe(true)
    }
    finally {
      if (typeof previous === "undefined") delete process.env[environmentVariable]
      else process.env[environmentVariable] = previous
    }
  })

  it("rejects Queue Definitions generated after Nitro config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-late-generated-"))
    roots.push(root)
    const plugin = hubQueue({ provider: "cloudflare" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await writeFile(join(root, "welcome.queue.ts"), "export default { handler: async () => undefined }\n")

    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow("changed after config resolution")
  })

  it("removes Queue bindings when final config discovery is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-empty-final-"))
    roots.push(root)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    const config = { nitro: { preset: "cloudflare_module" }, root }
    ;(plugin.config as unknown as (config: Record<string, unknown>) => void)(config)
    expect(config).toHaveProperty("nitro.cloudflare.wrangler.queues")
    await rm(definition)

    const resolvedConfig = {
      ...config,
      build: { outDir: "dist" },
      command: "build",
      plugins: [{ name: "nitro:main" }],
    }
    await (plugin.configResolved as (config: unknown) => Promise<void>)(resolvedConfig as never)

    expect(resolvedConfig.nitro).not.toHaveProperty("cloudflare.wrangler.queues")
  })

  it("rejects Queue Definitions removed after Nitro config resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-late-removed-"))
    roots.push(root)
    const definition = join(root, "welcome.queue.ts")
    await writeFile(definition, "export default { handler: async () => undefined }\n")
    const plugin = hubQueue({ provider: "cloudflare" })
    await (plugin.configResolved as (config: unknown) => Promise<void>)({
      build: { outDir: "dist" },
      command: "build",
      nitro: { preset: "cloudflare_module" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await rm(definition)

    await expect((plugin.closeBundle as () => Promise<void>)()).rejects.toThrow("changed after config resolution")
  })

  it("rejects ambiguous and conflicting custom Cloudflare bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    await writeFile(join(root, "first.queue.ts"), "export default { handler: async () => undefined }\n")
    await writeFile(join(root, "second.queue.ts"), "export default { handler: async () => undefined }\n")
    const custom = hubQueue({ provider: "cloudflare", binding: "JOBS" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => custom({ nitro: { preset: "cloudflare_module" }, root })).toThrow(/only be used with one Queue Definition/)

    await rm(join(root, "second.queue.ts"))
    const generatedBinding = "QUEUE_6669727374"
    const config = hubQueue({ provider: "cloudflare" }).config as unknown as (config: Record<string, unknown>) => unknown
    expect(() => config({ nitro: { preset: "cloudflare_module", cloudflare: { wrangler: { queues: { producers: [{ binding: generatedBinding, queue: "other" }] } } } }, root })).toThrow(/already assigned/)
  })
})
