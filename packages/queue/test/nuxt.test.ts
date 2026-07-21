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
    { dev: false, existingPlugin: true, mode: "build", namePrefix: "existing" },
    { dev: true, existingPlugin: false, mode: "dev", namePrefix: "quiver-airtable" },
  ])("installs Nitro Queue bindings during $mode", async ({ dev, existingPlugin, namePrefix }) => {
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
      ...(existingPlugin ? ["  vite: { plugins: [hubQueue({ namePrefix: 'existing', provider: 'cloudflare' })] },"] : []),
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
              consumers: [{ queue: `${namePrefix}queue--6169727461626c652d73796e63` }],
              producers: [{ binding: "QUEUE_6169727461626C652D73796E63", queue: `${namePrefix}queue--6169727461626c652d73796e63` }],
            },
          },
        },
        handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }],
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
      })

      const directConfig = {
        nitro: {
          alias: {},
          cloudflare: { wrangler: { observability: { enabled: true } } },
          plugins: ["server/plugin.ts"],
          preset: "cloudflare_module",
          virtual: {},
        },
        root,
      }
      const directOptions = existingPlugin ? { namePrefix: "existing", provider: "cloudflare" } as const : options
      ;(hubQueue(directOptions).config as unknown as (config: Record<string, unknown>) => void)(directConfig)
      const directNitro = directConfig.nitro as Record<string, unknown>
      expect(nitroConfig).toMatchObject({
        cloudflare: directNitro.cloudflare,
        handlers: directNitro.handlers,
        plugins: directNitro.plugins,
        rollupConfig: directNitro.rollupConfig,
      })

      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).resolves.toContain("cloudflare:queue")
      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")).resolves.toContain("enterQueueRuntimeEvent(event)")
    }
    finally {
      await nuxt.close()
    }
  })
})
