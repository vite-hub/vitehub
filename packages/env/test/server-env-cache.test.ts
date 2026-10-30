import { afterEach, describe, expect, it, vi } from "vitest"

import { env } from "../src/core/declarations.ts"
import { createRuntimeRegistry } from "../src/core/resolve.ts"
import { resolveServerEnv } from "../src/server.ts"

function registry() {
  return createRuntimeRegistry({
    api: {
      url: env({ source: env.source("CACHE_API_URL") }),
      retries: env.number({ default: 2, source: env.source("CACHE_API_RETRIES") }),
    },
  })
}

describe("resolveServerEnv reuse", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("reuses the result while the names it reads hold the same values", () => {
    const values = registry()
    const first = resolveServerEnv(values, { env: { CACHE_API_URL: "https://one.test" } })
    const second = resolveServerEnv(values, { env: { CACHE_API_URL: "https://one.test", UNRELATED: "changed" } })

    expect(second).toBe(first)
    expect(first).toEqual({ api: { url: "https://one.test", retries: 2 } })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.api)).toBe(true)
  })

  it("resolves again when a value it reads changes", () => {
    const values = registry()
    const first = resolveServerEnv(values, { env: { CACHE_API_URL: "https://one.test" } })
    const changed = resolveServerEnv(values, { env: { CACHE_API_URL: "https://two.test" } })
    const retries = resolveServerEnv(values, { env: { CACHE_API_URL: "https://two.test", CACHE_API_RETRIES: "5" } })

    expect(changed).not.toBe(first)
    expect(changed).toEqual({ api: { url: "https://two.test", retries: 2 } })
    expect(retries).toEqual({ api: { url: "https://two.test", retries: 5 } })
  })

  it("resolves again when a host variable changes", () => {
    const values = registry()
    vi.stubEnv("CACHE_API_URL", "https://host-one.test")
    const first = resolveServerEnv(values)
    expect(resolveServerEnv(values)).toBe(first)

    vi.stubEnv("CACHE_API_URL", "https://host-two.test")
    expect(resolveServerEnv(values)).toEqual({ api: { url: "https://host-two.test", retries: 2 } })
  })

  it("keeps the Worker env ahead of the host env", () => {
    const values = registry()
    vi.stubEnv("CACHE_API_URL", "https://host.test")

    expect(resolveServerEnv(values)).toEqual({ api: { url: "https://host.test", retries: 2 } })
    expect(resolveServerEnv(values, { env: { CACHE_API_URL: "https://worker.test" } })).toEqual({ api: { url: "https://worker.test", retries: 2 } })
  })

  it("gives each call its own copy of structured values", () => {
    const values = { settings: { required: false, default: { tags: ["first"] }, schema: { kind: "object" as const }, secret: false, source: { kind: "env" as const, label: "env:CACHE_SETTINGS", name: "CACHE_SETTINGS", serializable: true as const } } }
    const first = resolveServerEnv<{ settings: { tags: string[] } }>(values, { env: {} })
    first.settings.tags.push("changed")

    expect(resolveServerEnv<{ settings: { tags: string[] } }>(values, { env: {} }).settings).toEqual({ tags: ["first"] })
  })
})
