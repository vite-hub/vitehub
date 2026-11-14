import virtualConfig, { hosting as virtualHosting, kv as virtualKV } from "#vitehub/kv/config"

import { describe, expectTypeOf, it } from "vitest"

import type { Result } from "@vite-hub/runtime"

import { kv, type KVDriversWith, type KVErrorCode, type KVLockAcquisition, type KVLockErrorCode, type KVLockRunResult, type KVStorage, type ReadonlyKVStorage, type KVListPage, type KVOptions, type KVSetIfAbsentOptions, type KVStoreConfig, type ResolvedKVModuleOptions } from "../src/index.ts"
import { hubKV } from "../src/vite.ts"

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

  it("types kv options", () => {
    const options: KVOptions = {
      driver: "fs-lite",
    }

    expectTypeOf(options).toMatchTypeOf<KVOptions>()
  })

  it("types kv.get() and kv.getAndDelete() by their type option", () => {
    expectTypeOf(kv.get("code", { type: "text" })).toEqualTypeOf<Promise<Result<string | null, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.get("code", { type: "bytes" })).toEqualTypeOf<Promise<Result<Uint8Array | null, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.get<{ theme: string }>("settings")).toEqualTypeOf<Promise<Result<{ theme: string } | null, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.getAndDelete("code", { type: "text" })).toEqualTypeOf<Promise<Result<string | null, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    // @ts-expect-error getAndDelete() converts only to text.
    void kv.getAndDelete("code", { type: "bytes" })
  })

  it("exposes the intended kv runtime surface", () => {
    expectTypeOf(kv.clear).returns.toEqualTypeOf<Promise<Result<void, "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.delete).returns.toEqualTypeOf<Promise<Result<void, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.get<string>).returns.toEqualTypeOf<Promise<Result<string | null, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.getAndDelete<string>).returns.toEqualTypeOf<Promise<Result<string | null, "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    expectTypeOf(kv.has).returns.toEqualTypeOf<Promise<Result<boolean, "KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.increment).returns.toEqualTypeOf<Promise<Result<number, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    expectTypeOf(kv.keys).returns.toEqualTypeOf<Promise<Result<string[], "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.list).returns.toEqualTypeOf<Promise<Result<KVListPage, "KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_OPERATION_FAILED">>>()
    expectTypeOf(kv.setIfAbsent<string>).returns.toEqualTypeOf<Promise<Result<boolean, "KV_INVALID_TTL" | "KV_OPERATION_FAILED" | "KV_UNSUPPORTED_OPERATION">>>()
    expectTypeOf(kv.setIfAbsent<string>).parameter(2).toEqualTypeOf<KVSetIfAbsentOptions | undefined>()
    expectTypeOf(kv.set<string>).returns.toEqualTypeOf<Promise<Result<void, "KV_KEY_TOO_LONG" | "KV_METADATA_TOO_LARGE" | "KV_OPERATION_FAILED" | "KV_TTL_TOO_SHORT" | "KV_VALUE_TOO_LARGE">>>()
  })

  it("narrows kv results by the error element", async () => {
    const [error, value] = await kv.get<string>("settings")
    if (error) {
      expectTypeOf(error.code).toEqualTypeOf<"KV_KEY_TOO_LONG" | "KV_OPERATION_FAILED">()
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

    expectTypeOf<KVErrorCode>().toEqualTypeOf<"KV_INVALID_CURSOR" | "KV_INVALID_LIMIT" | "KV_INVALID_TTL" | "KV_INVALID_WAIT" | "KV_KEY_TOO_LONG" | "KV_METADATA_TOO_LARGE" | "KV_OPERATION_FAILED" | "KV_TTL_TOO_SHORT" | "KV_UNSUPPORTED_OPERATION" | "KV_VALUE_TOO_LARGE">()
  })

  it("types kv.lock() results and lists the drivers that support it", async () => {
    const lock = kv.lock("cron:daily", { ttl: 30, wait: 5 })
    expectTypeOf(lock.run(async () => 1)).toEqualTypeOf<Promise<Result<KVLockRunResult<number>, KVLockErrorCode>>>()
    expectTypeOf(lock.run(() => "done")).toEqualTypeOf<Promise<Result<KVLockRunResult<string>, KVLockErrorCode>>>()
    expectTypeOf(lock.acquire()).toEqualTypeOf<Promise<Result<KVLockAcquisition, KVLockErrorCode>>>()
    const [error, result] = await lock.run(async () => 1)
    if (!error && result.acquired) expectTypeOf(result.value).toEqualTypeOf<number>()
    if (!error && !result.acquired) {
      // @ts-expect-error The callback did not run, so there is no value.
      void result.value
    }
    // @ts-expect-error A lock needs a ttl.
    void kv.lock("cron:daily", {})
    expectTypeOf<KVDriversWith<"deleteIfEquals">>().toEqualTypeOf<"database" | "redis" | "upstash">()
  })

  it("returns a vite plugin with runtime config access", () => {
    const plugin = hubKV()

    expectTypeOf(plugin.api.getConfig().kv).toMatchTypeOf<false | ResolvedKVModuleOptions>()
  })

  it("exposes the generated config import types", () => {
    expectTypeOf(virtualHosting).toMatchTypeOf<string | undefined>()
    expectTypeOf(virtualKV).toMatchTypeOf<false | ResolvedKVModuleOptions>()
    expectTypeOf(virtualConfig.kv).toMatchTypeOf<false | ResolvedKVModuleOptions>()
  })
  it("returns a read-only handle without write methods", () => {
    const reader = kv.store("default", { mode: "read" })
    expectTypeOf(reader).toEqualTypeOf<ReadonlyKVStorage>()
    expectTypeOf(kv.store("cache")).toEqualTypeOf<KVStorage>()
    expectTypeOf(kv.store("cache", { mode: "write" })).toEqualTypeOf<KVStorage>()
    expectTypeOf(reader.get).toEqualTypeOf<KVStorage["get"]>()
    expectTypeOf(reader.has).toEqualTypeOf<KVStorage["has"]>()
    expectTypeOf(reader.keys).toEqualTypeOf<KVStorage["keys"]>()
    expectTypeOf(reader.list).toEqualTypeOf<KVStorage["list"]>()

    // @ts-expect-error A read-only handle has no set().
    void reader.set("settings", 1)
    // @ts-expect-error A read-only handle has no delete().
    void reader.delete("settings")
    // @ts-expect-error A read-only handle has no clear().
    void reader.clear
    // @ts-expect-error getAndDelete() deletes the key.
    void reader.getAndDelete
    // @ts-expect-error A read-only handle has no increment().
    void reader.increment
    // @ts-expect-error A read-only handle has no setIfAbsent().
    void reader.setIfAbsent
    // @ts-expect-error A read-only handle has no lock().
    void reader.lock
    // @ts-expect-error A read-only handle cannot select a writable store.
    void reader.store
    // @ts-expect-error mode is "read" or "write".
    void kv.store("default", { mode: "readonly" })
  })
})
