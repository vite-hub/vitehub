import { afterEach, describe, expect, it, vi } from "vitest"

import {
  consoleKVKey,
  consoleKVRegistryKey,
  consoleKVRootKey,
  installConsoleKVScope,
  resolveConsoleKV,
} from "../src/console/internal.ts"
import kvHandler from "../src/console/runtime/server/kv.get.ts"
import { installConsoleKV } from "../src/console/runtime/server/kv.ts"

import type { KVResult, KVStorage } from "@vite-hub/kv"
import type { ConsoleInvocationScope } from "../src/console/internal.ts"
import type { ConsoleRequestEvent } from "../src/console/runtime/server/request.ts"

const scope = globalThis as ConsoleInvocationScope

function success<TResult>(value: TResult): KVResult<TResult> {
  return [null, value]
}

function event(query = "", method = "GET"): ConsoleRequestEvent {
  return {
    method,
    node: { req: { method, url: `http://localhost/api/_vitehub/console/kv${query}` } },
    req: { method, url: `http://localhost/api/_vitehub/console/kv${query}` },
  }
}

function memoryKV(stores: Record<string, Map<string, unknown>>): { storage: KVStorage; writes: ReturnType<typeof vi.fn> } {
  const writes = vi.fn()
  function storage(name = "default"): KVStorage {
    const values = stores[name] ?? new Map<string, unknown>()
    return {
      clear: async () => { writes("clear"); return success(undefined) },
      del: async () => { writes("del"); return success(undefined) },
      get: async key => success(values.get(key) ?? null),
      has: async key => success(values.has(key)),
      keys: async base => success([...values.keys()].filter(key => key.startsWith(base ?? ""))),
      set: async () => { writes("set"); return success(undefined) },
      store: storage,
    }
  }
  return { storage: storage(), writes }
}

afterEach(() => {
  delete scope[consoleKVKey]
  delete scope[consoleKVRootKey]
  Reflect.deleteProperty(process, consoleKVKey)
  Reflect.deleteProperty(process, consoleKVRootKey)
  Reflect.deleteProperty(process, consoleKVRegistryKey)
})

describe("Console KV inspection", () => {
  it("isolates concurrent project stores across runtime realms", () => {
    const first = memoryKV({ default: new Map([["first", true]]) }).storage
    const second = memoryKV({ default: new Map([["second", true]]) }).storage
    const processRegistry = {}
    const firstScope: ConsoleInvocationScope = { process: processRegistry }
    const secondScope: ConsoleInvocationScope = { process: processRegistry }

    installConsoleKVScope("/first", { storage: first, stores: ["default"] }, firstScope)
    installConsoleKVScope("/second", { storage: second, stores: ["default"] }, secondScope)

    expect(resolveConsoleKV(firstScope)?.storage).toBe(first)
    expect(resolveConsoleKV(secondScope)?.storage).toBe(second)
    expect(resolveConsoleKV({ process: processRegistry })).toBeUndefined()
  })

  it("lists keys in stable order and exposes configured stores", async () => {
    const { storage, writes } = memoryKV({
      cache: new Map([["session:2", "second"]]),
      default: new Map([["user:2", true], ["user:1", false], ["other", 1]]),
    })
    installConsoleKV("/project", storage, ["cache", "default", "cache"])

    await expect(kvHandler(event("?prefix=user:&limit=1"))).resolves.toEqual({
      keys: ["user:1"],
      limit: 1,
      prefix: "user:",
      store: "default",
      stores: ["default", "cache"],
      total: 2,
      truncated: true,
    })
    await expect(kvHandler(event("?store=cache"))).resolves.toMatchObject({
      keys: ["session:2"],
      store: "cache",
    })
    expect(writes).not.toHaveBeenCalled()
  })

  it("formats structured, null, missing, and large values without writing", async () => {
    const { storage, writes } = memoryKV({
      default: new Map<string, unknown>([
        ["config", { enabled: true }],
        ["nullable", null],
        ["large", "x".repeat(256 * 1_024 + 1)],
        [" spaced ", "preserved"],
        ["unicode", "🟠".repeat(65_537)],
      ]),
    })
    installConsoleKV("/project", storage)

    await expect(kvHandler(event("?key=config"))).resolves.toEqual({
      found: true,
      format: "json",
      key: "config",
      store: "default",
      type: "object",
      value: "{\n  \"enabled\": true\n}",
    })
    await expect(kvHandler(event("?key=nullable"))).resolves.toMatchObject({
      found: true,
      type: "null",
      value: "null",
    })
    await expect(kvHandler(event("?key=missing"))).resolves.toEqual({
      found: false,
      key: "missing",
      store: "default",
    })
    await expect(kvHandler(event("?key=%20spaced%20"))).resolves.toMatchObject({
      found: true,
      key: " spaced ",
      value: "preserved",
    })
    await expect(kvHandler(event("?prefix=%20"))).resolves.toMatchObject({
      keys: [" spaced "],
      prefix: " ",
    })
    await expect(kvHandler(event("?key=large"))).resolves.toMatchObject({
      found: true,
      truncated: true,
      value: "x".repeat(256 * 1_024),
    })
    await expect(kvHandler(event("?key=unicode"))).resolves.toMatchObject({
      found: true,
      truncated: true,
      value: "🟠".repeat(65_536),
    })
    expect(writes).not.toHaveBeenCalled()
  })

  it("validates methods, stores, and list limits", async () => {
    const { storage } = memoryKV({ default: new Map() })
    installConsoleKV("/project", storage)

    await expect(kvHandler(event("", "POST"))).rejects.toMatchObject({ statusCode: 405 })
    await expect(kvHandler(event("?store=unknown"))).rejects.toMatchObject({ statusCode: 404 })
    await expect(kvHandler(event("?limit=501"))).rejects.toMatchObject({ statusCode: 400 })
  })
})
