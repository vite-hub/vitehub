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

    expect(config(userConfig)).toMatchObject({
      nitro: {
        cloudflare: { wrangler: { queues: { consumers: [{ queue: "queue--77656c636f6d65" }], producers: [{ binding: "QUEUE_77656C636F6D65", queue: "queue--77656c636f6d65" }] } } },
        plugins: ["server/plugin.ts", ".vitehub/nitro/queue/plugin.ts"],
      },
    })
    expect(config(userConfig)).toMatchObject({
      nitro: { plugins: ["server/plugin.ts", ".vitehub/nitro/queue/plugin.ts"] },
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
    expect(nitroPlugin).toContain("nitro.hooks.hook('cloudflare:queue'")
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
    const config = plugin.config as unknown as (config: Record<string, unknown>) => { nitro: Record<string, unknown> }
    expect(config({ nitro: { preset: "cloudflare_module" }, root })).toMatchObject({
      nitro: { cloudflare: { wrangler: { queues: { producers: [{ binding: "JOBS" }] } } } },
    })
    expect(config({ nitro: { preset: "cloudflare_pages" }, root }).nitro).not.toHaveProperty("cloudflare.wrangler.queues")
  })
})
