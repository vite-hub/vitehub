import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { afterEach, describe, expect, it } from "vitest"
import { loadNuxt } from "nuxt"

import { hubQueue } from "../src/vite.ts"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe("Queue Nuxt integration", () => {
  it.each([
    { dev: false, existingPlugin: true, mode: "build" },
    { dev: true, existingPlugin: false, mode: "dev" },
  ])("installs Nitro Queue bindings during $mode", async ({ dev, existingPlugin }) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nuxt-"))
    roots.push(root)
    await cp(join(import.meta.dirname, "../fixtures/nuxt"), root, { recursive: true })
    const options = { namePrefix: "quiver-airtable", provider: "cloudflare" } as const
    const queueNuxtUrl = pathToFileURL(join(import.meta.dirname, "../src/nuxt.ts")).href
    const queueViteUrl = pathToFileURL(join(import.meta.dirname, "../src/vite.ts")).href
    await writeFile(join(root, "nuxt.config.ts"), [
      `import queueNuxt from ${JSON.stringify(queueNuxtUrl)}`,
      `import { hubQueue } from ${JSON.stringify(queueViteUrl)}`,
      "export default defineNuxtConfig({",
      `  modules: [[queueNuxt, ${JSON.stringify(options)}]],`,
      "  nitro: { preset: 'cloudflare_module' },",
      ...(existingPlugin ? ["  vite: { plugins: [hubQueue({ provider: 'vercel' })] },"] : []),
      "})",
      "",
    ].join("\n"))

    const nuxt = await loadNuxt({ cwd: root, dev, ready: true })
    try {
      expect(nuxt.options.vite.plugins).toEqual([
        expect.objectContaining({ name: "@vite-hub/queue/vite" }),
      ])

      const nitroConfig: Record<string, unknown> = {
        alias: {},
        cloudflare: { wrangler: { observability: { enabled: true } } },
        plugins: ["server/plugin.ts"],
        preset: "cloudflare_module",
        virtual: {},
      }
      await (nuxt.callHook as unknown as (name: "nitro:config", config: Record<string, unknown>) => Promise<void>)("nitro:config", nitroConfig)

      expect(nitroConfig).toMatchObject({
        cloudflare: {
          wrangler: {
            compatibility_flags: ["nodejs_compat"],
            observability: { enabled: true },
            queues: {
              consumers: [{ queue: "quiver-airtablequeue--6169727461626c652d73796e63" }],
              producers: [{ binding: "QUEUE_6169727461626C652D73796E63", queue: "quiver-airtablequeue--6169727461626c652d73796e63" }],
            },
          },
        },
        handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }],
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
      })

      const directConfig = { nitro: { preset: "cloudflare_module" }, root }
      ;(hubQueue(options).config as unknown as (config: Record<string, unknown>) => void)(directConfig)
      const directQueues = (directConfig.nitro as unknown as { cloudflare: { wrangler: { queues: unknown } } }).cloudflare.wrangler.queues
      expect(nitroConfig).toHaveProperty("cloudflare.wrangler.queues", directQueues)

      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:queue")
      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")).resolves.toContain("enterQueueRuntimeEvent(event)")
    }
    finally {
      await nuxt.close()
    }
  })
})
