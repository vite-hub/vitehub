import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { VITEHUB_APP_BASE_URL } from "@vite-hub/internal/build/vite"
import { resolveConfig } from "vite"
import { describe, expect, it } from "vitest"

import { hubSource } from "../src/vite.ts"

describe("hubSource app base", () => {
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
