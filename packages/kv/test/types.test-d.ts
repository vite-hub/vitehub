import type { UserConfig } from "vite"
import virtualConfig, { hosting as virtualHosting, kv as virtualKV } from "#vitehub/kv/config"

import { describe, expectTypeOf, it } from "vitest"

import type { Result } from "@vite-hub/runtime"

import { kv, type KVErrorCode, type KVListPage, type KVModuleOptions, type KVStoreConfig, type ResolvedKVModuleOptions } from "../src/index.ts"
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
    expectTypeOf(kv.clear).returns.toEqualTypeOf<Promise<Result<void, "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.del).returns.toEqualTypeOf<Promise<Result<void, "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.get<string>).returns.toEqualTypeOf<Promise<Result<string | null, "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.getAndDelete<string>).returns.toEqualTypeOf<Promise<Result<string | null, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    expectTypeOf(kv.has).returns.toEqualTypeOf<Promise<Result<boolean, "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.increment).returns.toEqualTypeOf<Promise<Result<number, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    expectTypeOf(kv.keys).returns.toEqualTypeOf<Promise<Result<string[], "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.list).returns.toEqualTypeOf<Promise<Result<KVListPage, "KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.set<string>).returns.toEqualTypeOf<Promise<Result<void, "KV_OPERATION_FAILED">>>()
  })

  it("narrows kv results by the error element", async () => {
    const [error, value] = await kv.get<string>("settings")
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"KV_OPERATION_FAILED">()
      expectTypeOf(error.why).toEqualTypeOf<string>()
      expectTypeOf(error.fix).toEqualTypeOf<string | undefined>()
      expectTypeOf(error.docs).toEqualTypeOf<string | undefined>()
      expectTypeOf(value).toEqualTypeOf<undefined>()
      return
    }
    expectTypeOf(error).toEqualTypeOf<undefined>()
    expectTypeOf(value).toEqualTypeOf<string | null>()
  })

  it("types the codes of each method", async () => {
    const [listError] = await kv.list({ limit: 10 })
    if (listError) expectTypeOf(listError.code).toEqualTypeOf<"KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_OPERATION_FAILED">()

    const [incrementError] = await kv.increment("attempts", 60)
    if (incrementError) {
      expectTypeOf(incrementError.code).toEqualTypeOf<"KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">()
      // @ts-expect-error `increment()` never returns a cursor error.
      void (incrementError.code === "KV_INVALID_CURSOR")
    }

    expectTypeOf<KVErrorCode>().toEqualTypeOf<"KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">()
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
