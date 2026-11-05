import { afterEach, describe, expect, it, vi } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import type { SecretEnv } from "../src/secret.ts"
import { resolveServerEnv } from "../src/server.ts"

type Values = { api: { url: string, retries: number, token: SecretEnv } }

function registry() {
  return createRuntimeRegistry({
    api: {
      url: env({ source: env.source("CACHE_API_URL") }),
      retries: env.number({ default: 2, source: env.source("CACHE_API_RETRIES") }),
      token: env({ secret: true, default: "token", source: env.source("CACHE_API_TOKEN") }),
    },
  })
}

describe("resolveServerEnv reuse", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  // A SecretEnv is created when a value is parsed, so the same instance means the value was reused.
  it("reuses the resolved values while the names it reads hold the same values", () => {
    const values = registry()
    const first = resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://one.test" } })
    const second = resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://one.test", UNRELATED: "changed" } })

    expect(second.api.token).toBe(first.api.token)
    expect(second).toEqual({ api: { url: "https://one.test", retries: 2, token: first.api.token } })
  })

  it("resolves again when a value it reads changes", () => {
    const values = registry()
    const first = resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://one.test" } })
    const changed = resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://two.test" } })
    const retries = resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://two.test", CACHE_API_RETRIES: "5" } })

    expect(changed.api.token).not.toBe(first.api.token)
    expect(changed.api).toMatchObject({ url: "https://two.test", retries: 2 })
    expect(retries.api).toMatchObject({ url: "https://two.test", retries: 5 })
  })

  it("resolves again when a host variable changes", () => {
    const values = registry()
    vi.stubEnv("CACHE_API_URL", "https://host-one.test")
    const first = resolveServerEnv<Values>(values)
    expect(resolveServerEnv<Values>(values).api.token).toBe(first.api.token)

    vi.stubEnv("CACHE_API_URL", "https://host-two.test")
    expect(resolveServerEnv<Values>(values).api.url).toBe("https://host-two.test")
  })

  it("keeps the Worker env ahead of the host env", () => {
    const values = registry()
    vi.stubEnv("CACHE_API_URL", "https://host.test")

    expect(resolveServerEnv<Values>(values).api.url).toBe("https://host.test")
    expect(resolveServerEnv<Values>(values, { env: { CACHE_API_URL: "https://worker.test" } }).api.url).toBe("https://worker.test")
  })

  it("gives each call its own records", () => {
    const values = registry()
    const event = { env: { CACHE_API_URL: "https://one.test" } }
    const first = resolveServerEnv<Values>(values, event)
    first.api.url = "https://changed.test"

    expect(resolveServerEnv<Values>(values, event).api.url).toBe("https://one.test")
  })

  it("keeps provider values asynchronous in a reused result", () => {
    const values = createRuntimeRegistry({ api: { url: env({ source: env.source("CACHE_API_URL") }), key: env({ source: env.provider("secrets", "key") }) } })
    const event = { env: { CACHE_API_URL: "https://one.test" } }
    resolveServerEnv(values, event)
    const reused = resolveServerEnv<{ api: { url: string, key: string } }>(values, event)

    expect(reused.api.url).toBe("https://one.test")
    expect(() => reused.api.key).toThrow(expect.objectContaining({ code: "ENV_ASYNC_REQUIRED" }))
  })

  it("gives each call its own copy of structured values", () => {
    const values = { settings: { required: false, default: { tags: ["first"] }, schema: { kind: "object" as const }, secret: false, source: { kind: "env" as const, label: "env:CACHE_SETTINGS", name: "CACHE_SETTINGS", serializable: true as const } } }
    const first = resolveServerEnv<{ settings: { tags: string[] } }>(values, { env: {} })
    first.settings.tags.push("changed")

    expect(resolveServerEnv<{ settings: { tags: string[] } }>(values, { env: {} }).settings).toEqual({ tags: ["first"] })
  })
})
