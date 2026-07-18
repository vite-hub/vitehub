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

  it("registers Nitro runtime setup without Blob serving", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-runtime-"))
    const plugin = hubBlob({ driver: "fs", base: ".runtime/blob" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = {
      nitro: {
        plugins: ["server/plugin.ts"],
      },
    }

    expect(config(userConfig, { command: "build" })).toMatchObject({
      nitro: {
        plugins: ["server/plugin.ts", ".vitehub/nitro/blob/plugin.ts"],
      },
    })
    expect(config({
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
      },
    }, { command: "build" })).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
      },
    })
    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"base":".runtime/blob"')
    expect(nitroPlugin).not.toContain("#vitehub/blob/config")
    expect(nitroPlugin).toContain("setBlobRuntimeConfig(blobConfig)")
  })

  it("masks credentials embedded in Nitro runtime setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-masked-"))
    const previousToken = process.env.BLOB_READ_WRITE_TOKEN
    process.env.BLOB_READ_WRITE_TOKEN = "private-token"

    try {
      const plugin = hubBlob()
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      await configResolved({
        build: { outDir: "dist" },
        root,
      } as never)
    }
    finally {
      if (previousToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
      else process.env.BLOB_READ_WRITE_TOKEN = previousToken
    }

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).toContain('"token":"********"')
    expect(nitroPlugin).not.toContain("private-token")
  })

  it("registers an opt-in Nitro serving route", async () => {
    const plugin = hubBlob({ serve: true })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown

    expect(config({}, { command: "serve" })).toMatchObject({
      nitro: {
        plugins: [".vitehub/nitro/blob/plugin.ts"],
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
        headers: {
          "Cache-Control": "public, max-age=300",
          "X-Content-Type-Options": "nosniff",
        },
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
    expect(handler).toContain("const responseHeaders = {\"Cache-Control\":\"public, max-age=300\",\"X-Content-Type-Options\":\"nosniff\"}")
    expect(handler).toContain("getRouterParam(event, '_', { decode: false })")
    expect(handler).toContain("setResponseHeaders(event, responseHeaders)")
    expect(handler).toContain("blob.store(storeName).serve(event, pathname)")
    expect(handler.indexOf("setResponseHeaders(event, responseHeaders)")).toBeLessThan(
      handler.indexOf("blob.store(storeName).serve(event, pathname)"),
    )
  })

  it("uses a configured package base in physical Nitro imports", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-import-base-"))
    const plugin = hubBlob({
      driver: "fs",
      importBase: "vite-hub/_internal/blob",
      serve: true,
    } as never)
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>

    await configResolved({
      build: { outDir: "dist" },
      root,
    } as never)

    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    const handler = await readFile(join(root, ".vitehub", "blob", "serve-route.ts"), "utf8")
    expect(nitroPlugin).toContain("from 'vite-hub/_internal/blob/runtime/state'")
    expect(handler).toContain("from 'vite-hub/_internal/blob'")
    expect(`${nitroPlugin}\n${handler}`).not.toContain("@vite-hub/blob")
  })
})
