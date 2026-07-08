import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

  it("exposes resolved config through a stable ViteHub import path", async () => {
    const plugin = hubBlob({ driver: "fs", base: ".virtual/blob" })
    const resolveId = plugin.resolveId as (id: string) => string | undefined | Promise<string | undefined>
    const load = plugin.load as (id: string) => string | undefined | Promise<string | undefined>
    const resolvedId = await resolveId(BLOB_VIRTUAL_CONFIG_ID)
    const code = await load(resolvedId!)

    expect(code).toContain("export const blob =")
    expect(code).toContain(".virtual/blob")
  })

  it("registers an opt-in Nitro serving route", async () => {
    const plugin = hubBlob({ serve: true })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown

    expect(config({}, { command: "serve" })).toMatchObject({
      nitro: {
        handlers: [{
          handler: ".vitehub/blob/serve-route.ts",
          route: "/api/_vitehub/blob/**",
        }],
      },
    })
  })

  it("writes the generated Nitro serving route handler", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-serve-route-"))
    const plugin = hubBlob({
      serve: {
        route: "/assets",
        store: "media",
      },
      stores: {
        default: {
          driver: "fs",
        },
        media: {
          driver: "fs",
        },
      },
    })
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
    expect(handler).toContain("const storeName = \"media\"")
    expect(handler).toContain("getRouterParam(event, '_', { decode: false })")
    expect(handler).toContain("blob.store(storeName).serve(event, pathname)")
  })
})
