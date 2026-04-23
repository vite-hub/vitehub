import type { NitroModule } from "nitro/types"
import type { UserConfig } from "vite"
import virtualConfig, { blob as virtualBlob, hosting as virtualHosting } from "virtual:@vitehub/blob/config"

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

  it("exposes the intended Blob runtime surface", () => {
    expectTypeOf(blob.get).returns.toEqualTypeOf<Promise<Blob | null>>()
    expectTypeOf(blob.list).toBeFunction()
    expectTypeOf(blob.put).toBeFunction()
  })

  it("returns a vite plugin with runtime config access", () => {
    const plugin = hubBlob()
    expectTypeOf(plugin.api.getConfig().blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
    expectTypeOf(plugin.nitro).toMatchTypeOf<NitroModule>()
  })

  it("exposes the Vite virtual module config types", () => {
    expectTypeOf(virtualHosting).toMatchTypeOf<string | undefined>()
    expectTypeOf(virtualBlob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
    expectTypeOf(virtualConfig.blob).toMatchTypeOf<false | ResolvedBlobModuleOptions>()
  })
})
