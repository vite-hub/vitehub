import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_APP_BASE_URL } from "@vite-hub/internal/build/vite"
import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { hubSource } from "../src/vite.ts"

import type { NitroConfig } from "nitro/types"
import type { InlineConfig } from "vite"

describe("hubSource app base", () => {
  it("keeps preview interception before existing plugins after Vite config merging", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-preview-"))
    try {
      await mkdir(join(root, "server"))
      await writeFile(join(root, "server/content.ts"), 'import { defineContent } from "@vite-hub/content"\nexport default defineContent({ previews: true })')
      const options: InlineConfig & { nitro: NitroConfig } = { root, configFile: false, nitro: { plugins: ["async.mjs"] }, plugins: [hubSource()] }
      const config = await resolveConfig(options, "serve", "development")
      const nitro = Reflect.get(config, "nitro") as { plugins: string[] }
      expect(nitro.plugins[0]).toBe(join(root, ".vitehub/content/preview-routes.mjs"))
      expect(nitro.plugins.filter(plugin => plugin === "async.mjs")).toEqual(["async.mjs"])
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it.each([
    // Nuxt serves Vite assets from /_nuxt/ and passes the app base separately.
    [{ base: "/_nuxt/", [VITEHUB_APP_BASE_URL]: "/" }, "/"],
    [{ base: "/portal/" }, "/portal/"],
  ])("defines the app base URL from %j", async (options, expected) => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-source-base-"))
    try {
      const config = await resolveConfig({ root, configFile: false, ...options, plugins: [hubSource()] }, "serve", "development")
      expect(config.define?.__VITEHUB_APP_BASE_URL__).toBe(JSON.stringify(expected))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})
