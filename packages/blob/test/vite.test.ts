import { existsSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "vitest"
import { toSafeAppName } from "@vite-hub/internal/build/user-entry"

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

  it("contributes deduplicated R2 bindings when Nitro owns Cloudflare output", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-nitro-r2-"))
    const plugin = hubBlob({
      stores: {
        default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
      },
    })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const userConfig = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }

    config(userConfig, { command: "build" })
    expect(userConfig).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "ASSETS", bucket_name: "assets" },
    ])

    const resolved = {
      blob: {
        stores: {
          default: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
          assets: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
          assetsAlias: { binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" },
        },
      },
      build: { outDir: "dist" },
      nitro: {
        ...(userConfig as { nitro?: object }).nitro,
        cloudflare: {
          wrangler: {
            compatibility_flags: ["custom"],
            r2_buckets: [{ binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" }],
            routes: ["example.com/*"],
          },
        },
        preset: "cloudflare_module",
      },
      plugins: [{ name: "nitro:main" }],
      root,
    }
    await configResolved(resolved as never)

    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
      { binding: "ASSETS", bucket_name: "assets", jurisdiction: "eu" },
    ])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.routes", ["example.com/*"])
    expect(resolved).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["custom", "nodejs_compat"])
    expect(resolved).toHaveProperty("nitro.rollupConfig.external", ["cloudflare:workers"])
    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.observability")
  })

  it("uses Cloudflare defaults for the Nitro runtime when hosting is inferred", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-inferred-cloudflare-"))
    const previousBucket = process.env.BLOB_BUCKET_NAME
    const previousHosting = process.env.VITEHUB_HOSTING
    process.env.BLOB_BUCKET_NAME = "assets"
    process.env.VITEHUB_HOSTING = "cloudflare"
    try {
      const plugin = hubBlob()
      const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
      const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
      const value = { nitro: {}, build: { outDir: "dist" }, plugins: [{ name: "nitro:main" }], root }

      config(value, { command: "build" })
      await configResolved(value as never)

      expect(value).toHaveProperty("nitro.cloudflare.wrangler.r2_buckets", [
        { binding: "BLOB", bucket_name: "assets" },
      ])
      const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
      expect(nitroPlugin).toContain('"driver":"cloudflare-r2"')
      expect(nitroPlugin).toContain('"bucketName":"assets"')
      expect(nitroPlugin).toContain("import { env as vitehubEnv } from 'cloudflare:workers'")
      expect(nitroPlugin).toContain("setActiveCloudflareEnv(vitehubEnv)")
      expect(nitroPlugin).toContain("hooks.hook('request'")
      expect(nitroPlugin).toContain("event.context?._platform?.cloudflare?.env")
      expect(nitroPlugin).toContain("event.node?.req?.runtime?.cloudflare?.env ?? vitehubEnv")
    }
    finally {
      if (typeof previousBucket === "undefined") delete process.env.BLOB_BUCKET_NAME
      else process.env.BLOB_BUCKET_NAME = previousBucket
      if (typeof previousHosting === "undefined") delete process.env.VITEHUB_HOSTING
      else process.env.VITEHUB_HOSTING = previousHosting
    }
  })

  it("uses final Nitro ownership when the resolved preset changes", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-final-nitro-host-"))
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const closeBundle = plugin.closeBundle as () => void | Promise<void>
    const value = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }

    config(value, { command: "build" })
    await configResolved({
      build: { outDir: "dist/client" },
      nitro: { cloudflare: { wrangler: { routes: ["inactive.example/*"] } }, preset: "vercel" },
      plugins: [{ name: "nitro:main" }],
      root,
    } as never)
    await closeBundle()

    expect(existsSync(join(root, "dist", toSafeAppName(root), "index.js"))).toBe(true)
    const nitroPlugin = await readFile(join(root, ".vitehub", "nitro", "blob", "plugin.ts"), "utf8")
    expect(nitroPlugin).not.toContain("cloudflare:workers")
  })

  it("removes an early R2 contribution when the final Nitro host changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-final-nitro-cleanup-"))
    const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
    const config = plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown
    const configResolved = plugin.configResolved as (config: unknown) => void | Promise<void>
    const value = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }], root }

    config(value, { command: "build" })
    ;(value.nitro as Record<string, unknown>).preset = "vercel"
    const resolved = { ...value, build: { outDir: "dist" } }
    await configResolved(resolved as never)

    expect(resolved).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets.0")
  })

  it("does not contribute Cloudflare config for plain Vite or non-R2 stores", { timeout: 30_000 }, async () => {
    const config = (plugin: ReturnType<typeof hubBlob>, value: Record<string, unknown>) =>
      (plugin.config as unknown as (config: Record<string, unknown>, env: { command: "build" | "serve" }) => unknown)(value, { command: "build" })
    const root = await mkdtemp(join(tmpdir(), "vitehub-blob-plain-vite-"))
    const previousPreset = process.env.NITRO_PRESET
    process.env.NITRO_PRESET = "cloudflare_module"
    try {
      const plugin = hubBlob({ binding: "ASSETS", bucketName: "assets", driver: "cloudflare-r2" })
      const plainVite = { build: { outDir: "dist" }, root }
      config(plugin, plainVite)
      expect(plainVite).not.toHaveProperty("nitro.cloudflare")
      await (plugin.configResolved as (config: unknown) => void | Promise<void>)(plainVite as never)
      await (plugin.closeBundle as () => void | Promise<void>)()
      expect(existsSync(join(root, "dist", toSafeAppName(root), "index.js"))).toBe(true)
    }
    finally {
      if (typeof previousPreset === "undefined") delete process.env.NITRO_PRESET
      else process.env.NITRO_PRESET = previousPreset
    }

    const fsOnCloudflare = { nitro: { preset: "cloudflare_module" }, plugins: [{ name: "nitro:main" }] }
    config(hubBlob({ base: ".data/blob", driver: "fs" }), fsOnCloudflare)
    expect(fsOnCloudflare).not.toHaveProperty("nitro.cloudflare.wrangler.r2_buckets")
    expect(fsOnCloudflare).toHaveProperty("nitro.cloudflare.wrangler.compatibility_flags", ["nodejs_compat"])
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
