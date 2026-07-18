import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "vitest"

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
    const userConfig = { nitro: { plugins: ["server/plugin.ts"] }, root }

    config(userConfig)
    expect(userConfig).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { queues: { consumers: [{ queue: "queue--77656c636f6d65" }], producers: [{ binding: "QUEUE_77656C636F6D65", queue: "queue--77656c636f6d65" }] } } },
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
        rollupConfig: { external: ["cloudflare:workers"] },
      },
    })
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
    expect(nitroPlugin).toContain("enterQueueRuntimeEvent(event)")
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

  it("enables inferred queue config when hubQueue options are omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nitro-"))
    roots.push(root)
    const plugin = hubQueue()
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
    expect(underscorePages.nitro).not.toHaveProperty("cloudflare.wrangler.queues")
    const hyphenPages = { nitro: { preset: "cloudflare-pages" }, root }
    config(hyphenPages)
    expect(hyphenPages.nitro).not.toHaveProperty("cloudflare.wrangler.queues")
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
