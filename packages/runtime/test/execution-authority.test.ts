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
})
