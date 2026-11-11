import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { hubI18n } from "../src/vite.ts"

describe("hubI18n", () => {
  it("installs the Nitro 3 request context plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-i18n-vite-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      const config = { root, nitro: { plugins: ["/user-plugin.mjs"], experimental: { openAPI: true } } }
      const hook = plugin.config as { handler: (config: object) => Promise<unknown> }
      await hook.handler(config)

      const generatedPlugin = join(root, ".vitehub/nitro/i18n/plugin.mjs")
      expect(config.nitro).toMatchObject({
        plugins: [generatedPlugin, "/user-plugin.mjs"],
        experimental: { asyncContext: true, openAPI: true },
      })
      const source = await readFile(generatedPlugin, "utf8")
      expect(source).toContain('import { definePlugin } from "nitro"')
      expect(source).toContain('import { useRequest } from "nitro/context"')
      expect(source).toContain("return useRequest()")
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
