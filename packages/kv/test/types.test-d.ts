import type { UserConfig } from "vite"

import { describe, expectTypeOf, it } from "vitest"

import { kv, type KVModuleOptions, type KVStoreConfig, type ResolvedKVModuleOptions } from "../src/index.ts"
import { hubKv } from "../src/vite.ts"

describe("types", () => {
  it("narrows kv store configs by driver", () => {
    const store = {
      base: ".data/kv",
      driver: "fs-lite",
    } satisfies KVStoreConfig

    expectTypeOf(store.base).toEqualTypeOf<string>()
  })

  it("exposes the resolved module options shape", () => {
    const config = {
      store: {
        binding: "KV",
        driver: "cloudflare-kv-binding",
      },
    } satisfies ResolvedKVModuleOptions

    expectTypeOf(config.store.binding).toEqualTypeOf<string>()
  })

  it("augments vite user config with kv options", () => {
    const config: UserConfig = {
      kv: {
        driver: "fs-lite",
      },
    }

    expectTypeOf(config.kv).toMatchTypeOf<KVModuleOptions | undefined>()
  })

  it("exposes the intended kv runtime surface", () => {
    expectTypeOf(kv.get<string>).returns.toEqualTypeOf<Promise<string | null>>()
    expectTypeOf(kv.has).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(kv.keys).returns.toEqualTypeOf<Promise<string[]>>()
    expectTypeOf(kv.set<string>).returns.toEqualTypeOf<Promise<void>>()
  })

  it("returns a vite plugin with a nitro bridge", () => {
    const plugin = hubKv()

    expectTypeOf(plugin.nitro).toMatchTypeOf<{ name?: string }>()
  })
})
