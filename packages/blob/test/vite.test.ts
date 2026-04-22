import { describe, expect, it } from "vitest"

import { BLOB_VIRTUAL_CONFIG_ID, hubBlob } from "../src/vite.ts"

describe("hubBlob", () => {
  it("resolves Blob config from the Vite layer", () => {
    const plugin = hubBlob({ driver: "fs", base: ".cache/blob" })

    expect(plugin.api.getConfig()).toEqual({
      blob: {
        store: {
          base: ".cache/blob",
          driver: "fs",
        },
      },
    })
  })

  it("lets top-level config override inline plugin options", async () => {
    const plugin = hubBlob({ driver: "fs", base: ".inline/blob" })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      blob: {
        base: ".top-level/blob",
        driver: "fs",
      },
      build: { outDir: "dist" },
      root: process.cwd(),
    } as never)

    expect(plugin.api.getConfig()).toEqual({
      blob: {
        store: {
          base: ".top-level/blob",
          driver: "fs",
        },
      },
    })
  })

  it("exposes resolved config through a Vite virtual module", async () => {
    const plugin = hubBlob({ driver: "fs", base: ".virtual/blob" })
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(BLOB_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const blob =")
    expect(code).toContain(".virtual/blob")
  })
})
