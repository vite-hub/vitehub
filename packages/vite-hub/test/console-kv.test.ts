import { afterEach, describe, expect, it, vi } from "vitest"
import { Readable } from "node:stream"

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

// SAFETY: ConsoleInvocationScope only adds optional symbol-keyed test state to the global object.
const scope = globalThis as ConsoleInvocationScope

function success<TResult>(value: TResult): KVResult<TResult> {
  return [null, value]
}

function failure(message: string, cause?: unknown): KVResult<never> {
  const error = Object.assign(new Error(message), cause === undefined ? {} : { cause })
  // SAFETY: The handler under test consumes only the error message and cause from this failed KV result.
  return [error as Exclude<KVResult<never>[0], null>, undefined]
}

function event(query = "", method = "GET", body?: unknown): ConsoleRequestEvent {
  return {
    method,
    node: { req: { method, url: `http://localhost/api/_vitehub/console/kv${query}` } },
    req: { json: async () => body, method, url: `http://localhost/api/_vitehub/console/kv${query}` },
  }
}

function h3V1Event(body: unknown): ConsoleRequestEvent {
  const request = Readable.from([JSON.stringify(body)])
  Object.assign(request, { method: "POST", url: "http://localhost/api/_vitehub/console/kv" })
  return { method: "POST", node: { req: request } }
}

function h3V2Event(body: unknown): ConsoleRequestEvent {
  const request = new Request("http://localhost/api/_vitehub/console/kv", {
    body: JSON.stringify(body),
    method: "POST",
  })
  return { method: "POST", req: request }
}

function memoryKV(stores: Record<string, Map<string, unknown>>): { storage: KVStorage; writes: ReturnType<typeof vi.fn> } {
  const writes = vi.fn()
  function storage(name = "default"): KVStorage {
    const values = stores[name] ?? new Map<string, unknown>()
    return {
      clear: async () => { writes("clear"); return success(undefined) },
      del: async () => { writes("del"); return success(undefined) },
      // SAFETY: The in-memory fixture mirrors KVStorage's generic get contract for caller-selected values.
      get: async <T>(key: string) => success((values.get(key) ?? null) as T | null),
      getAndDelete: async <T>(key: string) => success((values.get(key) ?? null) as T | null),
      has: async key => success(values.has(key)),
      increment: async () => success(1),
      keys: async base => success([...values.keys()].filter(key => key.startsWith(base ?? ""))),
      list: async ({ cursor, limit, prefix = "" }) => {
        const matching = [...values.keys()].filter(key => key.startsWith(prefix)).sort()
        const start = cursor ? Number(cursor) : 0
        const keys = matching.slice(start, start + limit)
        const next = start + keys.length
        const page: { cursor?: string; keys: string[] } = { keys }
        if (next < matching.length) page.cursor = String(next)
        return success(page)
      },
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
      default: new Map<string, unknown>([["user:2", true], ["user:1", false], ["other", 1]]),
    })
    installConsoleKV("/project", storage, ["cache", "default", "cache"])

    await expect(kvHandler(event("?prefix=user:&limit=1"))).resolves.toEqual({
      keys: ["user:1"],
      cursor: "1",
      limit: 1,
      prefix: "user:",
      store: "default",
      stores: ["default", "cache"],
    })
    await expect(kvHandler(event("?prefix=user:&limit=1&cursor=1"))).resolves.toMatchObject({
      keys: ["user:2"],
      store: "default",
    })
    await expect(kvHandler(event("?store=cache"))).resolves.toMatchObject({
      keys: ["session:2"],
      store: "cache",
    })
    expect(writes).not.toHaveBeenCalled()
  })

  it("formats structured, null, missing, and large values without writing", async () => {
    const longKey = "key".repeat(8_192)
    const { storage, writes } = memoryKV({
      default: new Map<string, unknown>([
        ["", "empty key"],
        ["config", { enabled: true }],
        ["boxed", new Number(7)],
        ["boxed-custom", Object.assign(new Number(7), { toJSON: () => "replacement" })],
        ["boxed-bigint", Object(1n)],
        ["keyed", { toJSON: (key: string) => ({ key }) }],
        ["omitted", { child: { toJSON: () => undefined }, kept: true }],
        ["large-structured", { content: "x".repeat(256 * 1_024 + 1) }],
        ["nullable", null],
        ["large", "x".repeat(256 * 1_024 + 1)],
        ["large-bytes", new Uint8Array(128 * 1_024 + 1).fill(0xab)],
        [longKey, "long key"],
        [" spaced ", "preserved"],
        ["unicode", "🟠".repeat(65_537)],
      ]),
    })
    installConsoleKV("/project", storage)

    await expect(kvHandler(event("", "POST", { key: "" }))).resolves.toMatchObject({
      found: true,
      key: "",
      value: "empty key",
    })
    await expect(kvHandler(event("", "POST", { key: "config" }))).resolves.toEqual({
      found: true,
      format: "json",
      key: "config",
      store: "default",
      type: "object",
      value: "{\n  \"enabled\": true\n}",
    })
    await expect(kvHandler(h3V1Event({ key: "config" }))).resolves.toMatchObject({
      found: true,
      key: "config",
    })
    await expect(kvHandler(h3V2Event({ key: "config" }))).resolves.toMatchObject({
      found: true,
      key: "config",
    })
    const encode = vi.spyOn(TextEncoder.prototype, "encode")
    await expect(kvHandler(event("", "POST", { key: "boxed" }))).resolves.toMatchObject({ value: "7" })
    await expect(kvHandler(event("", "POST", { key: "boxed-custom" }))).resolves.toMatchObject({ value: "\"replacement\"" })
    await expect(kvHandler(event("", "POST", { key: "boxed-bigint" }))).resolves.toMatchObject({ format: "text", value: "1" })
    await expect(kvHandler(event("", "POST", { key: "keyed" }))).resolves.toMatchObject({
      value: "{\n  \"key\": \"\"\n}",
    })
    await expect(kvHandler(event("", "POST", { key: "omitted" }))).resolves.toMatchObject({
      value: "{\n  \"kept\": true\n}",
    })
    await expect(kvHandler(event("", "POST", { key: "nullable" }))).resolves.toMatchObject({
      found: true,
      type: "null",
      value: "null",
    })
    await expect(kvHandler(event("", "POST", { key: "missing" }))).resolves.toEqual({
      found: false,
      key: "missing",
      store: "default",
    })
    await expect(kvHandler(event("", "POST", { key: longKey }))).resolves.toMatchObject({
      found: true,
      key: longKey,
      value: "long key",
    })
    await expect(kvHandler(event("", "POST", { key: " spaced " }))).resolves.toMatchObject({
      found: true,
      key: " spaced ",
      value: "preserved",
    })
    await expect(kvHandler(event("?prefix=%20"))).resolves.toMatchObject({
      keys: [" spaced "],
      prefix: " ",
    })
    await expect(kvHandler(event("", "POST", { key: "large" }))).resolves.toMatchObject({
      found: true,
      truncated: true,
      value: "x".repeat(256 * 1_024),
    })
    await expect(kvHandler(event("", "POST", { key: "large-structured" }))).resolves.toMatchObject({
      found: true,
      truncated: true,
      type: "object",
    })
    await expect(kvHandler(event("", "POST", { key: "unicode" }))).resolves.toMatchObject({
      found: true,
      truncated: true,
      value: "🟠".repeat(65_536),
    })
    await expect(kvHandler(event("", "POST", { key: "large-bytes" }))).resolves.toMatchObject({
      found: true,
      truncated: true,
      type: "bytes",
      value: "ab".repeat(128 * 1_024),
    })
    expect(encode.mock.calls.reduce((maximum, [value]) => Math.max(maximum, value?.length ?? 0), 0)).toBeLessThanOrEqual(2)
    expect(writes).not.toHaveBeenCalled()
  })

  it("validates methods, stores, and list limits", async () => {
    const { storage } = memoryKV({ default: new Map() })
    installConsoleKV("/project", storage)

    await expect(kvHandler(event("", "DELETE"))).rejects.toMatchObject({ statusCode: 405 })
    await expect(kvHandler(event("", "POST"))).rejects.toMatchObject({ statusCode: 400 })
    await expect(kvHandler(h3V1Event({ key: "x".repeat(64 * 1_024) }))).rejects.toMatchObject({ statusCode: 413 })
    await expect(kvHandler(h3V2Event({ key: "x".repeat(64 * 1_024) }))).rejects.toMatchObject({ statusCode: 413 })
    await expect(kvHandler(event("?store=unknown"))).rejects.toMatchObject({ statusCode: 404 })
    await expect(kvHandler(event("?limit=501"))).rejects.toMatchObject({ statusCode: 400 })
  })

  it("exposes configured stores when the selected store cannot list keys", async () => {
    const { storage } = memoryKV({ cache: new Map(), default: new Map() })
    storage.list = async () => failure("default unavailable")
    installConsoleKV("/project", storage, ["default", "cache"])

    await expect(kvHandler(event())).resolves.toMatchObject({
      error: "default unavailable",
      keys: [],
      store: "default",
      stores: ["default", "cache"],
    })
  })

  it("identifies only expired cursors as retryable", async () => {
    const { storage } = memoryKV({ default: new Map() })
    const expiredCause = Object.assign(new Error("expired"), { code: "KV_CURSOR_EXPIRED" })
    storage.list = async () => failure("list unavailable", expiredCause)
    installConsoleKV("/project", storage)

    await expect(kvHandler(event("?cursor=continuation"))).resolves.toMatchObject({
      error: "list unavailable",
      errorCode: "cursor_expired",
    })
    await expect(kvHandler(event())).resolves.not.toHaveProperty("errorCode")
  })
})
