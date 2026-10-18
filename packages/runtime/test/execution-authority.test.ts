import { describe, expect, it } from "vitest"

import {
  isExecutionAuthority,
  noExecutionAuthority,
  normalizeExecutionAuthority,
  unknownExecutionAuthority,
} from "../src/index.ts"

describe("execution authority", () => {
  it("distinguishes no execution from unreported authority", () => {
    expect(noExecutionAuthority).toEqual({
      credentials: "none",
      environment: "none",
      filesystem: { access: "none", scope: "none" },
      isolation: "none",
      network: "none",
      processes: "none",
    })
    expect(unknownExecutionAuthority).toEqual({
      credentials: "unknown",
      environment: "unknown",
      filesystem: { access: "unknown", scope: "unknown" },
      isolation: "unknown",
      network: "unknown",
      processes: "unknown",
    })
    expect(Object.isFrozen(noExecutionAuthority)).toBe(true)
    expect(Object.isFrozen(noExecutionAuthority.filesystem)).toBe(true)
    expect(Object.isFrozen(unknownExecutionAuthority)).toBe(true)
    expect(Object.isFrozen(unknownExecutionAuthority.filesystem)).toBe(true)
    expect(isExecutionAuthority(noExecutionAuthority)).toBe(true)
    expect(isExecutionAuthority({ ...unknownExecutionAuthority, network: "maybe" })).toBe(false)
    expect(isExecutionAuthority({ ...unknownExecutionAuthority, credentials: ["unknown"] })).toBe(false)
    expect(isExecutionAuthority({
      ...unknownExecutionAuthority,
      network: { toString: () => "unknown" },
    })).toBe(false)
  })

  it("rejects authority objects whose accessors throw", () => {
    const hostile = Object.defineProperty({ ...unknownExecutionAuthority }, "network", {
      enumerable: true,
      get() { throw new Error("blocked network") },
    })

    expect(() => isExecutionAuthority(hostile)).not.toThrow()
    expect(isExecutionAuthority(hostile)).toBe(false)
  })

  it("normalizes provider declarations into immutable snapshots", () => {
    const declaration = {
      credentials: "unknown",
      environment: "selected",
      filesystem: { access: "read-write", scope: "sandbox" },
      isolation: "microvm",
      network: "restricted",
      processes: "arbitrary",
    } as const

    const authority = normalizeExecutionAuthority(declaration)

    expect(authority).toEqual(declaration)
    expect(authority).not.toBe(declaration)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.filesystem)).toBe(true)
    expect(normalizeExecutionAuthority(authority)).toBe(authority)
  })

  it("keeps module-owned canonical snapshots stable", () => {
    expect(normalizeExecutionAuthority(noExecutionAuthority)).toBe(noExecutionAuthority)
    expect(normalizeExecutionAuthority(unknownExecutionAuthority)).toBe(unknownExecutionAuthority)
  })

  it("snapshots frozen accessor descriptors only once", () => {
    let reads = 0
    const declaration = Object.freeze({
      ...unknownExecutionAuthority,
      get network() {
        reads++
        return reads === 1 ? "none" : "invalid"
      },
    })
    const authority = normalizeExecutionAuthority(declaration)

    expect(authority.network).toBe("none")
    expect(reads).toBe(1)
    expect(normalizeExecutionAuthority(authority)).toBe(authority)
    expect(reads).toBe(1)
    // Check identity after read counts because assertion formatting inspects accessors.
    expect(authority).not.toBe(declaration)
  })

  it("copies frozen proxy descriptors before they can be revoked", () => {
    const { proxy, revoke } = Proxy.revocable(unknownExecutionAuthority, {})
    const authority = normalizeExecutionAuthority(proxy)

    expect(authority).not.toBe(proxy)
    revoke()
    expect(authority).toEqual(unknownExecutionAuthority)
    expect(normalizeExecutionAuthority(authority)).toBe(authority)
    expect(isExecutionAuthority(proxy)).toBe(false)
    expect(() => normalizeExecutionAuthority(proxy)).toThrow("Invalid execution authority descriptor")
  })

  it("removes provider-specific fields from normalized snapshots", () => {
    const authority = normalizeExecutionAuthority({
      ...unknownExecutionAuthority,
      filesystem: {
        ...unknownExecutionAuthority.filesystem,
        providerPath: ["mutable"],
      },
      providerMetadata: { mutable: true },
    })

    expect(authority).toEqual(unknownExecutionAuthority)
    expect(Object.keys(authority)).toHaveLength(6)
    expect(Object.keys(authority.filesystem)).toHaveLength(2)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(Object.isFrozen(authority.filesystem)).toBe(true)
  })

  it("snapshots frozen descriptors with hidden provider fields", () => {
    const declaration = Object.freeze(Object.defineProperty({
      ...unknownExecutionAuthority,
      filesystem: unknownExecutionAuthority.filesystem,
    }, "providerMetadata", {
      get: () => ({ mutable: true }),
    }))

    const authority = normalizeExecutionAuthority(declaration)

    expect(authority).toEqual(unknownExecutionAuthority)
    expect(Reflect.ownKeys(authority)).toHaveLength(6)
  })
})
