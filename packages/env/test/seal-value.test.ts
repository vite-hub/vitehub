import * as v from "valibot"
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

import { seal, SecretEnv, unseal } from "../src/index.ts"
import { runWithCloudflareEnv } from "../src/server.ts"
import { cloudflareRequest } from "./cloudflare-request.ts"

import type { Result } from "@vite-hub/runtime"
import type { UnsealErrorCode } from "../src/index.ts"

const root = "seal-test-root-secret-at-least-32-characters"
const otherRoot = "another-root-secret-at-least-32-characters"

function flip(sealed: string, index: number): string {
  const bytes = Uint8Array.from(atob(sealed.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0))
  bytes[index]! ^= 1
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

beforeEach(() => {
  vi.stubEnv("VITEHUB_SECRET", root)
  vi.stubEnv("NUXT_APP_SECRET", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe("seal and unseal", () => {
  it.each([
    ["an object", { userId: "u_1", input: { title: "Café 🌍", tags: ["a", "b"] }, at: 1 }],
    ["a string", "hello"],
    ["a number", 42],
    ["a boolean", false],
    ["null", null],
    ["an array", [1, "two", { three: 3 }]],
    ["an empty array", []],
    ["a null-prototype object", { __proto__: null, userId: "u_1" }],
  ])("round-trips %s as JSON in a URL-safe string", async (_name, value) => {
    const sealed = await seal("app:test", value)
    expect(sealed).toMatch(/^[\w-]+$/)
    expect(sealed).not.toContain("hello")
    expect(await unseal("app:test", sealed)).toEqual([undefined, value])
  })

  it("uses a new IV for each value, so equal values give different strings", async () => {
    expect(await seal("app:test", { a: 1 })).not.toBe(await seal("app:test", { a: 1 }))
  })

  it("allows shared objects that do not form a cycle", async () => {
    const shared = { id: 1 }
    const value = { first: shared, second: shared }
    expect(await unseal("app:test", await seal("app:test", value))).toEqual([undefined, value])
  })

  it("checks and types the value with a schema", async () => {
    const schema = v.object({ userId: v.string() })
    const result = await unseal("app:test", await seal("app:test", { userId: "u_1", extra: true }), { schema })
    expectTypeOf(result).toEqualTypeOf<Result<{ userId: string }, UnsealErrorCode>>()
    const [error, value] = result
    if (error) throw error
    expect(value).toEqual({ userId: "u_1" })
    expectTypeOf(await unseal("app:test", "x")).toEqualTypeOf<Result<unknown, UnsealErrorCode>>()
  })

  it("returns ENV_SEAL_SCHEMA_MISMATCH with the issues in cause", async () => {
    const [error, value] = await unseal("app:test", await seal("app:test", { userId: 1 }), { schema: v.object({ userId: v.string() }) })
    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      code: "ENV_SEAL_SCHEMA_MISMATCH",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_schema_mismatch",
    })
    expect(error?.cause).toEqual([expect.objectContaining({ kind: "schema" })])
    expect(JSON.stringify(error)).not.toContain("userId")
  })

  it("returns ENV_SEAL_WRONG_PURPOSE for a value of another purpose", async () => {
    const [error, value] = await unseal("app:choice", await seal("app:token", { id: 1 }))
    expect(value).toBeUndefined()
    expect(error).toMatchObject({
      code: "ENV_SEAL_WRONG_PURPOSE",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_wrong_purpose",
    })
    expect(error?.why).toContain("app:choice")
  })

  it.each([
    ["the version", 0],
    ["the expiry", 8],
    ["the IV", 15],
    ["the ciphertext", 30],
  ])("returns ENV_SEAL_INVALID when %s changes", async (_part, index) => {
    const sealed = await seal("app:test", { role: "member" }, { ttl: 60 })
    const [error] = await unseal("app:test", flip(sealed, index))
    expect(error?.code).toBe("ENV_SEAL_INVALID")
  })

  it.each(["", "not sealed", "a.b", "AAAA", "%%%"])("returns ENV_SEAL_INVALID for %j", async (input) => {
    const [error] = await unseal("app:test", input)
    expect(error).toMatchObject({
      code: "ENV_SEAL_INVALID",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_invalid",
    })
  })

  it("returns ENV_SEAL_INVALID after the root secret changes", async () => {
    const sealed = await seal("app:test", { id: 1 })
    vi.stubEnv("VITEHUB_SECRET", otherRoot)
    const [error] = await unseal("app:test", sealed)
    expect(error?.code).toBe("ENV_SEAL_INVALID")
  })

  it("returns ENV_SEAL_EXPIRED once the ttl has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-11-07T10:00:00.000Z"))
    const sealed = await seal("app:upload", { id: 1 }, { ttl: 900 })
    vi.setSystemTime(new Date("2026-11-07T10:14:59.999Z"))
    expect(await unseal("app:upload", sealed)).toEqual([undefined, { id: 1 }])
    vi.setSystemTime(new Date("2026-11-07T10:15:00.000Z"))
    const [error] = await unseal("app:upload", sealed)
    expect(error).toMatchObject({ code: "ENV_SEAL_EXPIRED", why: "The sealed value expired at 2026-11-07T10:15:00.000Z." })
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "ENV_SEAL_EXPIRED",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_expired",
      fix: expect.any(String),
      name: "ENV_SEAL_EXPIRED",
      why: "The sealed value expired at 2026-11-07T10:15:00.000Z.",
    })
  })

  it("keeps a value without ttl", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const sealed = await seal("app:credentials", { token: "t" })
    vi.setSystemTime(Date.now() + 10 * 365 * 24 * 3600 * 1000)
    expect(await unseal("app:credentials", sealed)).toEqual([undefined, { token: "t" }])
  })

  it("uses a separate root secret for stored values", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    const secret = new SecretEnv("finance-encryption-key-of-32-characters-or-more")
    const sealed = await seal("finance:credentials", { apiKey: "k" }, { secret })
    expect(await unseal("finance:credentials", sealed, { secret: secret.unseal() })).toEqual([undefined, { apiKey: "k" }])
    vi.stubEnv("VITEHUB_SECRET", root)
    const [error] = await unseal("finance:credentials", sealed)
    expect(error?.code).toBe("ENV_SEAL_INVALID")
  })

  it("reads the root secret from Cloudflare bindings", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    const event = cloudflareRequest({ VITEHUB_SECRET: root })
    const sealed = await seal("app:test", { id: 1 }, { event })
    expect(await runWithCloudflareEnv({ VITEHUB_SECRET: root }, () => unseal("app:test", sealed))).toEqual([undefined, { id: 1 }])
  })

  it("throws ENV_REQUIRED_MISSING without a root secret", async () => {
    vi.stubEnv("VITEHUB_SECRET", "")
    await expect(seal("app:test", { id: 1 })).rejects.toMatchObject({ code: "ENV_REQUIRED_MISSING" })
    await expect(unseal("app:test", "not sealed")).rejects.toMatchObject({ code: "ENV_REQUIRED_MISSING" })
  })

  it.each([
    ["an empty purpose", () => seal("", 1)],
    ["a zero ttl", () => seal("app:test", 1, { ttl: 0 })],
    ["a negative ttl", () => seal("app:test", 1, { ttl: -1 })],
    ["a NaN ttl", () => seal("app:test", 1, { ttl: Number.NaN })],
    ["undefined", () => seal("app:test", undefined)],
    ["a function", () => seal("app:test", () => 1)],
    ["a BigInt", () => seal("app:test", 1n)],
    ["a symbol", () => seal("app:test", Symbol("scope"))],
    ["NaN", () => seal("app:test", Number.NaN)],
    ["Infinity", () => seal("app:test", Number.POSITIVE_INFINITY)],
    ["negative Infinity", () => seal("app:test", Number.NEGATIVE_INFINITY)],
    ["nested undefined", () => seal("app:test", { role: "admin", scope: undefined })],
    ["a nested function", () => seal("app:test", { scope: () => "admin" })],
    ["a nested symbol", () => seal("app:test", { scope: Symbol("admin") })],
    ["a nested BigInt", () => seal("app:test", { id: 1n })],
    ["nested NaN", () => seal("app:test", { counts: [Number.NaN] })],
    ["nested Infinity", () => seal("app:test", [{ count: Number.POSITIVE_INFINITY }])],
    ["nested negative Infinity", () => seal("app:test", { count: Number.NEGATIVE_INFINITY })],
    ["undefined in an array", () => seal("app:test", [undefined])],
    ["a function in an array", () => seal("app:test", [() => 1])],
    ["a symbol in an array", () => seal("app:test", [Symbol("scope")])],
    ["a sparse array", () => {
      const values = [1]
      values.length = 2
      return seal("app:test", { values })
    }],
    ["a Date", () => seal("app:test", { createdAt: new Date() })],
    ["a Map", () => seal("app:test", new Map([["scope", "admin"]]))],
    ["a Set", () => seal("app:test", new Set(["admin"]))],
    ["a typed array", () => seal("app:test", new Uint8Array([1, 2]))],
    ["a custom toJSON", () => seal("app:test", { toJSON: () => "other" })],
    ["a symbol key", () => seal("app:test", { [Symbol("scope")]: "admin" })],
    ["an array property", () => seal("app:test", Object.assign([1], { scope: "admin" }))],
    ["a cycle", () => {
      const value: Record<string, unknown> = {}
      value.self = value
      return seal("app:test", value)
    }],
    ["a short secret", () => seal("app:test", 1, { secret: "short" })],
    ["an empty purpose in unseal", () => unseal("", "x")],
  ])("throws ENV_SEAL_ARGUMENT_INVALID for %s", async (_name, call) => {
    await expect(call()).rejects.toMatchObject({
      code: "ENV_SEAL_ARGUMENT_INVALID",
      docs: "https://vitehub.dev/docs/env/diagnostics/env_seal_argument_invalid",
    })
  })
})
