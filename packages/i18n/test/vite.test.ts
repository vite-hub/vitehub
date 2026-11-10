import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { VITEHUB_NITRO_MAJOR_VERSION } from "@vite-hub/internal/build/vite"
import { describe, expect, it } from "vitest"

import { hubI18n } from "../src/vite.ts"

const packageRoot = fileURLToPath(new URL("..", import.meta.url))

describe("hubI18n", () => {
  it("refuses Nuxt 4, whose Nitro 2 server has no request context on every host", async () => {
    const root = await mkdtemp(join(packageRoot, "test/.tmp/nitro2-"))
    try {
      const plugin = hubI18n({ locales: ["en", "es"], projectRoot: root })
      const config = { root, [VITEHUB_NITRO_MAJOR_VERSION]: 2 }
      const hook = plugin.config as { handler: (config: object) => Promise<unknown> }
      await expect(hook.handler(config)).rejects.toMatchObject({ code: "I18N_UNSUPPORTED_HOST" })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
