import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createNitro, prepare, prerender } from "nitro/builder"
import { describe, expect, it } from "vitest"

import { addConsolePageHandlers, ignoreConsolePrerender } from "../src/console/nitro.ts"

describe("Console prerendering with a Nitro base", () => {
  it("also ignores the Console relative to the Nitro base in Nuxt", () => {
    const nitro = { baseURL: "/docs/", prerender: { ignore: ["/private"] } }
    addConsolePageHandlers(nitro, "/runtime", "/docs/")
    addConsolePageHandlers(nitro, "/runtime", "/docs/")
    expect(nitro.prerender.ignore).toEqual(["/private", "/docs/_vitehub", "/_vitehub"])
  })

  it("keeps absolute and relative Console links out of Nitro's crawler below a base", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-console-crawler-"))
    let nitro: Awaited<ReturnType<typeof createNitro>> | undefined
    try {
      await writeFile(join(root, "home.mjs"), `export default () => new Response('<a href="/docs/_vitehub/content">Console</a><a href="_vitehub/content">Console</a>', { headers: { "content-type": "text/html" } })`)
      await writeFile(join(root, "console.mjs"), `export default () => new Response("Console requires authentication", { status: 500 })`)
      const config = { baseURL: "/docs/", prerender: { crawlLinks: true, failOnError: true, ignore: [] as string[] } }
      ignoreConsolePrerender(config, "/docs/")
      nitro = await createNitro({
        ...config,
        rootDir: root,
        preset: "node",
        compatibilityDate: "2026-09-03",
        logLevel: 0,
        handlers: [
          { route: "/", handler: join(root, "home.mjs") },
          { route: "/_vitehub/**", handler: join(root, "console.mjs") },
        ],
      })
      await prepare(nitro)
      await prerender(nitro)
      expect(nitro._prerenderedRoutes?.map(route => route.route)).toEqual(["/"])
    }
    finally {
      await nitro?.close()
      await rm(root, { force: true, recursive: true })
    }
  }, 30_000)
})
