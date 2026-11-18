import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { loadNuxt } from "nuxt"
import { expect, it } from "vitest"

import type { Nuxt, NuxtConfig } from "nuxt/schema"

it("gives share images no runtime cache, so Nitro does not install lru-cache into the app", async () => {
  // Inside the package, so Nuxt resolves the docs dependencies as an installed app does.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-og-image-cache-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content"))
    await writeFile(join(root, "content/index.md"), "---\ntitle: Lumen\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    let drivers: string[] | undefined
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [
        [docs, { mcp: false, linkChecker: false, site: { name: "Lumen", url: "https://lumen.example.com" } }],
        // Read the options Nitro resolved, after every module changed them.
        (_options: unknown, nuxt: Nuxt) => {
          nuxt.hook("nitro:init", (nitro) => {
            drivers = Object.values({ ...nitro.options.storage, ...nitro.options.devStorage }).map((mount: { driver?: string }) => mount.driver ?? "")
          })
        },
      ],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: config, ready: true })

    expect(drivers).toBeDefined()
    expect(drivers).not.toContain("lru-cache")
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

it("resolves the mocked-exports import of the share image mocks from this package", async () => {
  // nuxt-og-image replaces optional server packages, such as `utf-8-validate` of `ws`, with virtual modules that import
  // `mocked-exports/proxy`. A pnpm app does not depend on mocked-exports, so Nitro must not resolve it from the app.
  const root = await mkdtemp(join(import.meta.dirname, ".tmp-og-image-mocks-"))
  const docs = (await import(pathToFileURL(join(import.meta.dirname, "../dist/nuxt.js")).href)).default as never
  let nuxt: Awaited<ReturnType<typeof loadNuxt>> | undefined
  try {
    await mkdir(join(root, "content"))
    await writeFile(join(root, "content/index.md"), "---\ntitle: Lumen\n---\nHello\n")
    await writeFile(join(root, "nuxt.config.ts"), "export default defineNuxtConfig({})\n")
    let alias: Record<string, string> | undefined
    let mock: unknown
    const config: NuxtConfig = {
      dev: false,
      devtools: { enabled: false },
      modules: [
        [docs, { mcp: false, linkChecker: false, site: { name: "Lumen", url: "https://lumen.example.com" } }],
        (_options: unknown, nuxt: Nuxt) => {
          nuxt.hook("nitro:init", (nitro) => {
            alias = nitro.options.alias
            mock = nitro.options.virtual["utf-8-validate"]
          })
        },
      ],
    }
    nuxt = await loadNuxt({ cwd: root, overrides: config, ready: true })

    expect(mock).toContain("mocked-exports/proxy")
    expect(alias?.["mocked-exports/proxy"]).toMatch(/[\\/]mocked-exports[\\/]lib[\\/]proxy\.mjs$/)
    expect(existsSync(alias!["mocked-exports/proxy"]!)).toBe(true)
  }
  finally {
    await nuxt?.close()
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)
