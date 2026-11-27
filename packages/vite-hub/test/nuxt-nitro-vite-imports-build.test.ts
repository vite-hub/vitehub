import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { describe, expect, it } from "vitest"

import viteHubNuxt from "vite-hub/nuxt"
import { buildNitro, createNuxt, nuxtFixture } from "./support/nuxt-nitro-build.ts"

describe("Vite imports in Nuxt with a separate Nitro build", () => {
  it("bundles import.meta.glob() and ?raw imports in the built Node server", { timeout: 240_000 }, async () => {
    const { app, root } = await nuxtFixture()
    try {
      await mkdir(join(app, "server/pages"), { recursive: true })
      await mkdir(join(app, "server/routes"), { recursive: true })
      await writeFile(join(app, "server/notice.txt"), "Read me first.\n")
      await writeFile(join(app, "server/pages/intro.md"), "# Intro\n")
      await writeFile(join(app, "server/pages/usage.md"), "# Usage\n")
      await writeFile(join(app, "server/routes/files.get.ts"), `
import { defineHandler } from "nitro/h3"
import notice from "../notice.txt?raw"

const pages = import.meta.glob("../pages/*.md", { eager: true, import: "default", query: "?raw" })

export default defineHandler(() => ({ notice, pages }))
`)
      const { nitroConfig, nuxt } = createNuxt(app, false)
      await viteHubNuxt({ env: false, host: "node" }, nuxt)
      await buildNitro(await nitroConfig())

      const entry = pathToFileURL(join(app, ".output/server/index.mjs")).href
      const { default: server } = await import(entry) as { default: { fetch(request: Request): Promise<Response> } }
      const response = await server.fetch(new Request("http://127.0.0.1/files"))
      expect(response.status, await response.clone().text()).toBe(200)
      expect(await response.json()).toEqual({
        notice: "Read me first.\n",
        pages: { "../pages/intro.md": "# Intro\n", "../pages/usage.md": "# Usage\n" },
      })
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
