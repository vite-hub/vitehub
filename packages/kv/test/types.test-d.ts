import type { UserConfig } from "vite"
import virtualConfig, { hosting as virtualHosting, kv as virtualKV } from "#vitehub/kv/config"

import { describe, expectTypeOf, it } from "vitest"

import { kv, type KVModuleOptions, type KVResult, type KVStoreConfig, type ResolvedKVModuleOptions } from "../src/index.ts"
import { hubKv } from "../src/vite.ts"

describe("types", () => {
  it("narrows kv store configs by driver", () => {
    const store = {
      base: ".vitehub/data/kv",
      driver: "fs-lite",
    } satisfies KVStoreConfig

    expectTypeOf(store.base).toEqualTypeOf<string>()
  })

  it("accepts native Deno KV store config", () => {
    const store = {
      driver: "deno-kv",
      path: ":memory:",
    } satisfies KVStoreConfig

    expectTypeOf(store.path).toEqualTypeOf<string>()
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
    expectTypeOf(kv.get<string>).returns.toEqualTypeOf<Promise<KVResult<string | null>>>()
    expectTypeOf(kv.has).returns.toEqualTypeOf<Promise<KVResult<boolean>>>()
    expectTypeOf(kv.keys).returns.toEqualTypeOf<Promise<KVResult<string[]>>>()
    expectTypeOf(kv.set<string>).returns.toEqualTypeOf<Promise<KVResult<void>>>()
  })

  it("narrows kv results by the error element", async () => {
    const [error, value] = await kv.get<string>("settings")
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"KV_OPERATION_FAILED">()
      expectTypeOf(value).toEqualTypeOf<undefined>()
      return
    }
    expectTypeOf(error).toEqualTypeOf<null>()
    expectTypeOf(value).toEqualTypeOf<string | null>()
  })

  it("returns a vite plugin with runtime config access", () => {
    const plugin = hubKv()

    expectTypeOf(plugin.api.getConfig().kv).toMatchTypeOf<false | ResolvedKVModuleOptions>()
  })

  it("exposes the generated config import types", () => {
    expectTypeOf(virtualHosting).toMatchTypeOf<string | undefined>()
    expectTypeOf(virtualKV).toMatchTypeOf<false | ResolvedKVModuleOptions>()
    expectTypeOf(virtualConfig.kv).toMatchTypeOf<false | ResolvedKVModuleOptions>()
  })
})
