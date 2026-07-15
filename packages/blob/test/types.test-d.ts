import type { UserConfig } from "vite"
import virtualConfig, { blob as virtualBlob, hosting as virtualHosting } from "#vitehub/blob/config"

import { describe, expectTypeOf, it } from "vitest"

import { blob, type BlobModuleOptions, type BlobStoreConfig, type ResolvedBlobModuleOptions } from "../src/index.ts"
import { hubBlob } from "../src/vite.ts"

describe("types", () => {
  it("narrows Blob store configs by driver", () => {
    const store = {
      base: ".data/blob",
      driver: "fs",
    } satisfies BlobStoreConfig

    expectTypeOf(store.base).toEqualTypeOf<string>()
  })

  it("exposes the resolved module options shape", () => {
    const config = {
      store: {
        binding: "BLOB",
        driver: "cloudflare-r2",
      },
    } satisfies ResolvedBlobModuleOptions

    expectTypeOf(config.store.binding).toEqualTypeOf<string>()
  })

  it("augments vite user config with blob options", () => {
    const config: UserConfig = {
      blob: {
        driver: "fs",
      },
    }

    expectTypeOf(config.blob).toMatchTypeOf<BlobModuleOptions | undefined>()
  })

  it("allows MinIO to resolve common Docker env defaults", () => {
    const config: UserConfig = {
      blob: {
        driver: "minio",
      },
    }

    expectTypeOf(config.blob).toMatchTypeOf<BlobModuleOptions | undefined>()
  })

  it("exposes the intended Blob runtime surface", () => {
    expectTypeOf(blob.get).returns.toEqualTypeOf<Promise<Blob | null>>()
    expectTypeOf(blob.list).toBeFunction()
    expectTypeOf(blob.put).toBeFunction()
    expectTypeOf(blob.sign("private/audio.mp3", { expiresIn: 900, method: "GET" })).toMatchTypeOf<Promise<{
      headers: Record<string, string>
      method: "GET" | "PUT"
      url: string
    }>>()
    expectTypeOf(blob.sign("private/audio.mp3", {
      contentType: "audio/mpeg",
      createOnly: true,
      expiresIn: 900,
      method: "PUT",
    })).toMatchTypeOf<Promise<{ url: string }>>()
  })

  it("returns a vite plugin with runtime config access", () => {
    const plugin = hubBlob()
    expectTypeOf(plugin.api.getConfig().blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
  })

  it("exposes the generated config import types", () => {
    expectTypeOf(virtualHosting).toMatchTypeOf<string | undefined>()
    expectTypeOf(virtualBlob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
    expectTypeOf(virtualConfig.blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
  })
})
