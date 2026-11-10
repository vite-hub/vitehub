import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { installI18nNuxt } from "../src/nuxt.ts"

describe("Nuxt", () => {
  it("adds one plugin that hydrates the server locale", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "vitehub-i18n-nuxt-"))
    const nuxt = { options: { plugins: [] as Array<string | { src: string }> } }
    await installI18nNuxt(nuxt, { importBase: "vite-hub/i18n", nitroMajorVersion: 3, projectRoot })
    await installI18nNuxt(nuxt, { importBase: "vite-hub/i18n", nitroMajorVersion: 3, projectRoot })

    expect(nuxt.options.plugins).toEqual([join(projectRoot, ".vitehub/i18n/nuxt-plugin.mjs")])
    const plugin = await readFile(join(projectRoot, ".vitehub/i18n/nuxt-plugin.mjs"), "utf8")
    expect(plugin).toContain(`from "vite-hub/i18n/runtime"`)
    expect(plugin).toContain("nuxtApp.payload.vitehubLocale")
  })

  it("refuses Nuxt 4, which builds the server with Nitro 2", async () => {
    const nuxt = { options: { plugins: [] } }
    await expect(installI18nNuxt(nuxt, { importBase: "vite-hub/i18n", nitroMajorVersion: 2, projectRoot: tmpdir() })).rejects.toMatchObject({ code: "I18N_UNSUPPORTED_HOST" })
    expect(nuxt.options.plugins).toEqual([])
  })
})
