import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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
      ...(existingPlugin ? ["  vite: { plugins: [[hubQueue({ namePrefix: 'existing', provider: 'cloudflare' })]] },"] : []),
      "})",
      "",
    ].join("\n"))

    const nuxt = await loadNuxt({ cwd: root, overrides: { dev }, ready: true })
    try {
      expect((nuxt.options.vite.plugins as unknown[]).flat(Infinity)).toEqual([
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
        handlers: [{ handler: join(root, ".vitehub/nitro/queue/middleware.ts"), middleware: true, route: "/**" }],
        plugins: [join(root, ".vitehub/nitro/queue/plugin.ts"), "server/plugin.ts"],
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
        rollupConfig: directNitro.rollupConfig,
      })
      expect(directNitro).toMatchObject({
        handlers: [{ handler: ".vitehub/nitro/queue/middleware.ts", middleware: true, route: "/**" }],
        plugins: [".vitehub/nitro/queue/plugin.ts", "server/plugin.ts"],
      })

      const generatedPlugin = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
      const generatedMiddleware = await readFile(join(root, ".vitehub", "nitro", "queue", "middleware.ts"), "utf8")
      expect(generatedPlugin).toContain("cloudflare:queue")
      expect(generatedMiddleware).toContain("enterQueueRuntimeEvent(event)")
      if (dev) {
        expect(`${generatedPlugin}\n${generatedMiddleware}`).not.toContain("cloudflare:workers")
        expect(generatedPlugin).not.toContain("setQueueRuntimeEventDefaults({")
        expect(generatedMiddleware).toContain("runtimeEvent.node?.req?.runtime?.cloudflare?.env")
        expect(generatedMiddleware).not.toContain("?? vitehubEnv")
      }
      else {
        expect(`${generatedPlugin}\n${generatedMiddleware}`).toContain("cloudflare:workers")
        expect(generatedPlugin).toContain("setQueueRuntimeEventDefaults({")
        expect(generatedMiddleware).toContain("Object.assign(event")
      }
    }
    finally {
      await nuxt.close()
    }
  })

  it("discovers suffix definitions from Nuxt srcDir and server queues from the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-queue-nuxt-src-dir-"))
    roots.push(root)
    await cp(join(import.meta.dirname, "../fixtures/nuxt"), root, { recursive: true })
    await mkdir(join(root, "app"), { recursive: true })
    await mkdir(join(root, "backend", "queues"), { recursive: true })
    await writeFile(join(root, "app", "welcome.queue.ts"), "export default {}\n")
    await writeFile(join(root, "backend", "queues", "custom.ts"), "export default {}\n")
    const queueNuxtUrl = pathToFileURL(join(import.meta.dirname, "../src/nuxt.ts")).href
    await writeFile(join(root, "nuxt.config.ts"), [
      `import queueNuxt from ${JSON.stringify(queueNuxtUrl)}`,
      "export default defineNuxtConfig({",
      "  modules: [[queueNuxt, { provider: 'cloudflare' }]],",
      "  nitro: { preset: 'cloudflare_module' },",
      "  serverDir: 'backend',",
      "  srcDir: 'app',",
      "})",
      "",
    ].join("\n"))
    const nuxt = await loadNuxt({ cwd: root, overrides: { dev: false }, ready: true })
    try {
      const nitroConfig: Record<string, unknown> = {
        alias: {},
        cloudflare: { wrangler: {} },
        plugins: [],
        preset: "cloudflare_module",
        virtual: {},
      }
      await (nuxt.callHook as unknown as (name: "nitro:config", config: Record<string, unknown>) => Promise<void>)("nitro:config", nitroConfig)
      const runtime = await readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")
      expect(runtime).toContain('"welcome"')
      expect(runtime).toContain('"custom"')
      expect(runtime).not.toContain('"app/welcome"')

      const plugin = (nuxt.options.vite.plugins as unknown[]).flat(Infinity)[0] as ReturnType<typeof hubQueue>
      const viteRoot = join(root, "app")
      await (plugin.configResolved as (config: unknown) => Promise<void>)({
        build: { outDir: "dist" },
        command: "serve",
        nitro: nitroConfig,
        plugins: [],
        queue: { provider: "cloudflare" },
        resolve: { alias: [] },
        root: viteRoot,
      } as never)
      const addedDefinition = join(viteRoot, "added.queue.ts")
      await writeFile(addedDefinition, "export default {}\n")
      await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
        file: addedDefinition,
        server: { config: { root: viteRoot } },
      })
      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).resolves.toContain('"added"')
      const addedServerDefinition = join(root, "backend", "queues", "added-server.ts")
      await writeFile(addedServerDefinition, "export default {}\n")
      await (plugin.handleHotUpdate as (context: unknown) => Promise<void>)({
        file: addedServerDefinition,
        server: { config: { root: viteRoot } },
      })
      await expect(readFile(join(root, ".vitehub", "nitro", "queue", "plugin.ts"), "utf8")).resolves.toContain('"added-server"')
    }
    finally {
      await nuxt.close()
    }
  })
})
